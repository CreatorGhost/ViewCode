import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { CodeViewDiffItem, CodeViewHandle } from "@pierre/diffs/react";
import { reviewedChangeLabel } from "@t3tools/client-runtime/agent-review";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  reviewFindingEntries,
  reviewFindingIdentity,
  reviewFindingMarksByKey,
  type ReviewFindingEntry,
  type ReviewFindingKey,
  mergeReviewFindingRatings,
  REVIEW_HEAD_MOVED_NOTICE,
  type ReviewFindingsSource,
  reviewFindingRatingsEqual,
  reviewFixAllMode,
  reviewIssueOrder,
  reviewPostAllWaits,
  reviewRereviewBasis,
  reviewRereviewSummary,
  unsettledReviewFindingRatings,
} from "@t3tools/client-runtime/review-findings";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ProjectId,
  PullRequestReviewVerdict,
  ReviewFindingRating,
  ReviewVerdict,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type PostedReviewFinding,
  REVIEW_FINDING_SEVERITY_LABELS,
  REVIEW_VERDICT_LABELS,
  reviewFindingsMode,
} from "@t3tools/shared/reviewFindings";
import { Link } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FoldVerticalIcon,
  MessageSquarePlusIcon,
  UnfoldVerticalIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { cn } from "~/lib/utils";
import { fnv1a32, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { useServerConfigs, useThreadShell } from "../../state/entities";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  REVIEW_SEVERITY_BADGES,
  type ReviewFindingAction,
  ReviewFindingCard,
} from "./ReviewFindingCard";
import { ReviewFixAllDialog } from "./ReviewFixAllDialog";
import {
  type ReviewFixChat,
  type ReviewFixRequest,
  resolveReviewFixChat,
  useRevealReviewFix,
  useSendReviewFixToChat,
} from "./reviewFixChat";
import { ReviewPostDialog } from "./ReviewPostDialog";
import { FindIssuesButton, type ReviewStartTarget } from "./ReviewStart";
import {
  firstFindingToReveal,
  placeReviewFindings,
  revealFirstAgain,
  type PlacedReviewFinding,
  postedReviewFindingsEqual,
  reviewFileCollapsed,
  reviewFindingsFixPrompt,
} from "./reviewPanel.logic";
import {
  type ReviewFixDestination,
  reviewFindingsCardKey,
  useReviewFixSentStore,
} from "./reviewFixSentStore";
import { useReviewDiff } from "./useReviewDiff";

export const REVIEW_VERDICT_BADGES: Record<ReviewVerdict, "success" | "info" | "warning"> = {
  approve: "success",
  "approve-with-nits": "info",
  "request-changes": "warning",
};

/** A request for this thread's composer and the chip records its text refers to. */
export type ReviewFixInChatRequest = ReviewFixRequest;

/**
 * Fix with agent where no chat sits beside the view (the pull request page): sends the request
 * into the chat it picks, and resolves to where it went, for marking the findings sent there.
 */
export type ReviewFixInChat = (
  request: ReviewFixInChatRequest,
) => Promise<ReviewFixDestination | null>;

/**
 * Marks a finding the reader stepped to with one fade of the accent, then leaves it as it was. The
 * card may be drawn a frame or two after the scroll that brings it in.
 */
function flashReviewFinding(find: () => HTMLElement | undefined, attempt = 0): void {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const element = find();
  if (element === undefined) {
    if (attempt < 10) requestAnimationFrame(() => flashReviewFinding(find, attempt + 1));
    return;
  }
  element.animate(
    [
      { backgroundColor: "color-mix(in srgb, var(--primary) 16%, var(--background))" },
      { backgroundColor: "var(--background)" },
    ],
    { duration: 1200, easing: "ease-out" },
  );
}

interface FindingAnnotationGroup {
  readonly findings: ReadonlyArray<PlacedReviewFinding>;
}

const EMPTY_SENT: Readonly<Record<string, ReviewFixDestination>> = {};
const EMPTY_DISMISSED: Readonly<Record<string, true>> = {};
const NO_PENDING_RATINGS: ReadonlyMap<string, ReviewFindingRating | null> = new Map();

interface ReviewFindingsViewProps {
  readonly environmentId: EnvironmentId;
  /** The thread the view sits beside; null on the pull request page, which is no thread. */
  readonly threadRef: ScopedThreadRef | null;
  readonly source: ReviewFindingsSource;
  readonly projectId: ProjectId | null;
  readonly cwd: string | undefined;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  /** How the findings are rated, from the review thread's records. */
  readonly ratings: ReadonlyMap<string, ReviewFindingRating>;
  /**
   * Fix with agent for a view with no chat beside it (the pull request page). Absent: the chat
   * beside the view, or seen from the reviewer itself the chat the review was started from.
   */
  readonly onFixInChat: ReviewFixInChat | undefined;
  /** Where a new review of the same change starts, when one can. */
  readonly startReview: ReviewStartTarget | null;
  /** These are the findings so far of a review still at work; a later set replaces them. */
  readonly stillReviewing: boolean;
  /**
   * Whether the reader has scrolled the review surface themselves, in which case opening does not
   * jump to the first finding.
   */
  readonly readerScrolled: () => boolean;
}

/**
 * One set of findings over the change it reviewed: a toolbar to walk and act on them, who
 * reviewed it and when, the findings no line of the diff can carry, then the diff with every other
 * finding under its lines. Unchanged regions stay folded the way the diff viewer folds them.
 * Shown by a thread's Review panel and by the pull request page's Review tab. Memoized: the
 * source and the posted record are recomputed whenever a linked thread changes, the view only
 * cares when what they say does, and a redraw would rebuild every annotation in the diff.
 */
export const ReviewFindingsView = memo(
  ReviewFindingsViewContent,
  (previous, next) =>
    previous.environmentId === next.environmentId &&
    previous.threadRef === next.threadRef &&
    previous.projectId === next.projectId &&
    previous.cwd === next.cwd &&
    previous.onFixInChat === next.onFixInChat &&
    previous.startReview === next.startReview &&
    previous.stillReviewing === next.stillReviewing &&
    previous.readerScrolled === next.readerScrolled &&
    previous.source.activityId === next.source.activityId &&
    previous.source.threadTitle === next.source.threadTitle &&
    postedReviewFindingsEqual(previous.posted, next.posted) &&
    reviewFindingRatingsEqual(previous.ratings, next.ratings),
);

function ReviewFindingsViewContent({
  environmentId,
  threadRef,
  source,
  projectId,
  cwd,
  posted,
  ratings: serverRatings,
  onFixInChat,
  startReview,
  stillReviewing,
  readerScrolled,
}: ReviewFindingsViewProps) {
  const { findings } = source;
  const reviewThreadRef = useMemo(
    () => scopeThreadRef(environmentId, source.threadId),
    [environmentId, source.threadId],
  );
  // The reader's marks belong to the review, by finding identity, so they hold when its next set
  // of findings arrives.
  const cardKey = reviewFindingsCardKey(environmentId, source.threadId);
  const sentByIdentity = useReviewFixSentStore((state) => state.sentByCard[cardKey] ?? EMPTY_SENT);
  const dismissedByIdentity = useReviewFixSentStore(
    (state) => state.dismissedByCard[cardKey] ?? EMPTY_DISMISSED,
  );
  // The reader's clicks until the server records them, so a thumb answers at once.
  const [pendingRatings, setPendingRatings] = useState(NO_PENDING_RATINGS);
  const unsettledRatings = unsettledReviewFindingRatings(serverRatings, pendingRatings);
  if (unsettledRatings !== pendingRatings) setPendingRatings(unsettledRatings);
  const ratings = useMemo(
    () => mergeReviewFindingRatings(serverRatings, unsettledRatings),
    [serverRatings, unsettledRatings],
  );
  const [showDismissed, setShowDismissed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  const [ticks, setTicks] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  // The issue stepped to, by identity, so it stays the same issue when a newer set renumbers it.
  const [currentIdentity, setCurrentIdentity] = useState<string | null>(null);
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [fixing, setFixing] = useState<ReadonlyArray<ReviewFindingEntry> | null>(null);
  // The view lives as long as its review, so a newer set of the same review (sent while it
  // works) keeps the scroll position but not choices made about the earlier set's findings,
  // whose keys now name other findings.
  const [shownActivityId, setShownActivityId] = useState(source.activityId);
  if (shownActivityId !== source.activityId) {
    setShownActivityId(source.activityId);
    setExpanded(new Set());
    setTicks(new Set());
    setPendingRatings(NO_PENDING_RATINGS);
  }
  const [viewer, setViewer] = useState<CodeViewHandle<FindingAnnotationGroup> | null>(null);
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const capabilities = useServerConfigs().get(environmentId)?.environment.capabilities;
  const rereview = useMemo(
    () =>
      startReview !== null && capabilities?.incrementalAgentReview === true
        ? reviewRereviewBasis(source, startReview.request)
        : null,
    [capabilities?.incrementalAgentReview, source, startReview],
  );
  const rereviewSummary = reviewRereviewSummary(findings);

  const diff = useReviewDiff({
    environmentId,
    target: findings.target,
    projectId,
    cwd: cwd ?? null,
    scope: source.scope,
  });
  const entries = useMemo(() => reviewFindingEntries(findings), [findings]);
  const sent = useMemo(
    () => reviewFindingMarksByKey(entries, sentByIdentity),
    [entries, sentByIdentity],
  );
  const dismissed = useMemo(
    () => reviewFindingMarksByKey(entries, dismissedByIdentity),
    [dismissedByIdentity, entries],
  );
  const currentKey = useMemo<ReviewFindingKey | null>(
    () =>
      currentIdentity === null
        ? null
        : (entries.find((entry) => reviewFindingIdentity(entry.finding) === currentIdentity)?.key ??
          null),
    [currentIdentity, entries],
  );
  const identityOf = useCallback(
    (key: ReviewFindingKey) => {
      const entry = entries.find((candidate) => candidate.key === key);
      return entry === undefined ? key : reviewFindingIdentity(entry.finding);
    },
    [entries],
  );
  const dismissedCount = entries.filter((entry) => dismissed[entry.key]).length;
  const shown = useMemo(
    () => (showDismissed ? entries : entries.filter((entry) => !dismissed[entry.key])),
    [dismissed, entries, showDismissed],
  );
  const { general, placed } = useMemo(
    () => placeReviewFindings(shown, diff.files),
    [diff.files, shown],
  );
  // Previous and Next walk what is on screen, in reading order.
  const order = useMemo(() => reviewIssueOrder(general, placed), [general, placed]);
  const openEntries = entries.filter((entry) => !dismissed[entry.key]);
  const currentIndex = currentKey === null ? -1 : order.indexOf(currentKey);
  // Before the reader steps, the counter stands on the first issue, which is already at the top.
  const shownIndex = Math.max(currentIndex, 0);
  const currentPlacement = placed.find((entry) => entry.entry.key === currentKey) ?? null;

  const toggleExpanded = useCallback(
    (key: ReviewFindingKey) =>
      setExpanded((current) => {
        const next = new Set(current);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const tick = useCallback(
    (key: ReviewFindingKey, value: boolean) =>
      setTicks((current) => {
        const next = new Set(current);
        if (value) next.add(key);
        else next.delete(key);
        return next;
      }),
    [],
  );
  const setDismissedFor = useReviewFixSentStore((state) => state.setDismissed);
  const dismiss = useCallback(
    (key: ReviewFindingKey, value: boolean) => setDismissedFor(cardKey, identityOf(key), value),
    [cardKey, identityOf, setDismissedFor],
  );
  const rateFinding = useAtomCommand(reviewEnvironment.rateFinding, { reportFailure: false });
  const canRate = capabilities?.reviewFindingRatings === true;
  const rate = useCallback(
    (key: ReviewFindingKey, rating: ReviewFindingRating | null) => {
      setPendingRatings((current) => new Map(current).set(key, rating));
      void rateFinding({
        environmentId,
        input: {
          reviewThreadId: source.threadId,
          findingsActivityId: source.activityId,
          findingKey: key,
          rating,
        },
      }).then((result) => {
        if (result._tag !== "Failure") return;
        // Back to what the server has, unless a later click already replaced this one.
        setPendingRatings((current) => {
          if (current.get(key) !== rating) return current;
          const next = new Map(current);
          next.delete(key);
          return next;
        });
        if (isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not save the rating",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
      });
    },
    [environmentId, rateFinding, source.activityId, source.threadId],
  );

  // Somebody else's pull request: findings are posted to it as review comments, not fixed.
  const pullRequestTarget = findings.target.kind === "pull-request" ? findings.target : null;
  const commentMode = reviewFindingsMode(findings) === "comment" && pullRequestTarget !== null;
  const postFindings = useAtomCommand(reviewEnvironment.postFindings, { reportFailure: false });
  const [posting, setPosting] = useState<ReadonlyArray<ReviewFindingEntry> | null>(null);
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
  const [failures, setFailures] = useState<ReadonlyMap<string, string>>(() => new Map());
  const submitPost = async (
    selection: ReadonlyArray<ReviewFindingEntry>,
    input: { verdict: PullRequestReviewVerdict; overallComment: string },
  ): Promise<boolean> => {
    if (pullRequestTarget === null) return false;
    const keys = selection.map((entry) => entry.key);
    setBusyKeys(new Set(keys));
    const result = await postFindings({
      environmentId,
      input: {
        reviewThreadId: source.threadId,
        findingsActivityId: source.activityId,
        target: pullRequestTarget,
        verdict: input.verdict,
        overallComment: input.overallComment,
        findings: selection.map((entry) => ({ key: entry.key, finding: entry.finding })),
      },
    });
    setBusyKeys(new Set());
    if (result._tag === "Failure") {
      if (isAtomCommandInterrupted(result)) return false;
      const error = squashAtomCommandFailure(result);
      const message = error instanceof Error ? error.message : "Could not post the review.";
      // A review is one request, so its failure is every finding's it carried.
      setFailures(
        (current) => new Map([...current, ...keys.map((key) => [key, message] as const)]),
      );
      toastManager.add({ type: "error", title: "Could not post the review", description: message });
      return false;
    }
    setFailures(
      (current) =>
        new Map([...current].filter(([key]) => !keys.some((sentKey) => sentKey === key))),
    );
    setTicks(new Set());
    toastManager.add({
      type: "success",
      title: selection.length === 1 ? "Posted the finding" : `Posted ${selection.length} findings`,
      ...(result.value.headMoved === true ? { description: REVIEW_HEAD_MOVED_NOTICE } : {}),
      actionProps: {
        children: "Open pull request",
        onClick: () => window.open(result.value.url, "_blank", "noopener,noreferrer"),
      },
    });
    return true;
  };
  // The cards' action keeps one identity per set, so the memoized cards do not redraw for it.
  const startPost = useCallback(
    (keys: ReadonlyArray<string>) => {
      setPosting(entries.filter((entry) => keys.includes(entry.key)));
    },
    [entries, setPosting],
  );
  // Fixing is a request in a chat's composer that the reader sends themselves, never another
  // session picked here: the chat beside the panel, or seen from the reviewer itself (reviewers do
  // not fix) the chat the review was started from (`resolveReviewFixChat`).
  const fixInReviewThread = source.threadId === threadRef?.threadId;
  const panelThread = useThreadShell(threadRef);
  const markSent = useReviewFixSentStore((state) => state.markSent);
  const revealFix = useRevealReviewFix();
  const openSent = useCallback(
    (destination: ReviewFixDestination) => revealFix(environmentId, destination),
    [environmentId, revealFix],
  );
  const sendToChat = useSendReviewFixToChat();
  const fix = useCallback(
    async (selection: ReadonlyArray<ReviewFindingEntry>) => {
      if (selection.length === 0) return;
      const request = reviewFindingsFixPrompt({
        activityId: source.activityId,
        entries: selection,
      });
      const keys = selection.map((entry) => entry.key);
      // The pull request page has its own way to a chat (`onFixInChat`).
      if (onFixInChat !== undefined) {
        const sent = await onFixInChat(request);
        if (sent) markSent(cardKey, keys.map(identityOf), sent);
        return;
      }
      const chat: ReviewFixChat | null =
        !fixInReviewThread && threadRef !== null
          ? { kind: "thread", ref: threadRef, title: panelThread?.title ?? "this chat" }
          : resolveReviewFixChat({
              environmentId,
              reviewThreadId: source.threadId,
              projectId,
              target: findings.target,
            });
      if (chat === null) return;
      const destination = await sendToChat(environmentId, chat, request);
      if (destination !== null) markSent(cardKey, keys.map(identityOf), destination);
    },
    [
      cardKey,
      environmentId,
      findings.target,
      fixInReviewThread,
      identityOf,
      markSent,
      onFixInChat,
      panelThread,
      projectId,
      sendToChat,
      source.activityId,
      source.threadId,
      threadRef,
    ],
  );
  const cardAction = useMemo<ReviewFindingAction>(
    () =>
      commentMode
        ? { kind: "post", label: "Post comment", run: (key) => startPost([key]) }
        : {
            kind: "fix",
            label: "Fix with agent",
            run: (key) => void fix(entries.filter((candidate) => candidate.key === key)),
          },
    [commentMode, entries, fix, startPost],
  );

  const filesWithFindings = useMemo(() => new Set(placed.map((entry) => entry.fileKey)), [placed]);
  // Files with findings open and the rest fold, until the reader says otherwise.
  const fileCollapsed = (fileKey: string) =>
    reviewFileCollapsed(fileKey, filesWithFindings, toggledFiles);
  const toggleFile = useCallback(
    (fileKey: string) =>
      setToggledFiles((current) => {
        const next = new Set(current);
        if (!next.delete(fileKey)) next.add(fileKey);
        return next;
      }),
    [],
  );

  // Each step to a finding, the same one again included (Issue 1/1), scrolls to it and marks it.
  const [focusStep, setFocusStep] = useState(0);
  const readerNavigated = useRef(false);
  const goTo = (index: number) => {
    const key = order[index];
    if (key === undefined) return;
    readerNavigated.current = true;
    setCurrentIdentity(identityOf(key));
    setFocusStep((step) => step + 1);
    const placement = placed.find((entry) => entry.entry.key === key);
    // A folded file opens so its finding can be shown.
    if (placement && fileCollapsed(placement.fileKey)) toggleFile(placement.fileKey);
  };
  // Cards by key, to mark the one stepped to: the diff draws its cards wherever it likes.
  const cardElements = useRef(new Map<string, HTMLElement>());
  const registerCard = useCallback((key: ReviewFindingKey, element: HTMLElement | null) => {
    if (element === null) cardElements.current.delete(key);
    else cardElements.current.set(key, element);
  }, []);
  /** Scrolls a finding into view and marks it once; false while its file is not drawn yet. */
  const reveal = useCallback(
    (key: ReviewFindingKey): boolean => {
      const placement = placed.find((entry) => entry.entry.key === key) ?? null;
      if (placement === null) {
        cardElements.current.get(key)?.scrollIntoView({ block: "nearest" });
      } else {
        if (viewer === null) return false;
        viewer.scrollTo({
          type: "range",
          id: placement.fileKey,
          range: {
            start: placement.startLine,
            end: placement.lineNumber,
            side: "additions",
            endSide: "additions",
          },
          align: "center",
        });
      }
      flashReviewFinding(() => cardElements.current.get(key));
      return true;
    },
    [placed, viewer],
  );
  // Scrolls once the viewer has drawn the finding's file open.
  useEffect(() => {
    if (focusStep === 0 || currentKey === null) return;
    reveal(currentKey);
  }, [currentKey, focusStep, reveal]);
  // Opening the view, or the first findings arriving, goes to the first one, unless the reader
  // has already scrolled somewhere of their own.
  const autoRevealed = useRef(false);
  // A newer set renumbers the issues: the panel goes to the new first one when it had gone to the
  // first on its own, so the counter ("Issue 1/4") and the card in view agree.
  const revealedForSet = useRef(source.activityId);
  useEffect(() => {
    if (revealedForSet.current === source.activityId) return;
    revealedForSet.current = source.activityId;
    if (
      revealFirstAgain({
        autoRevealed: autoRevealed.current,
        readerNavigated: readerNavigated.current,
        readerScrolled: readerScrolled(),
      })
    ) {
      autoRevealed.current = false;
    }
  }, [readerScrolled, source.activityId]);
  useEffect(() => {
    const first = firstFindingToReveal({
      order,
      diffPending: diff.pending,
      revealed: autoRevealed.current,
      readerScrolled: readerScrolled(),
    });
    if (first !== null && reveal(first)) autoRevealed.current = true;
  }, [diff.pending, order, readerScrolled, reveal]);

  const items = useMemo<CodeViewDiffItem<FindingAnnotationGroup>[]>(
    () =>
      diff.files.map(({ fileKey, fileDiff }) => {
        const inFile = placed.filter((entry) => entry.fileKey === fileKey);
        const byLine = new Map<number, PlacedReviewFinding[]>();
        for (const entry of inFile) {
          byLine.set(entry.lineNumber, [...(byLine.get(entry.lineNumber) ?? []), entry]);
        }
        const annotations = [...byLine].map(
          ([lineNumber, group]): DiffLineAnnotation<FindingAnnotationGroup> => ({
            side: "additions",
            lineNumber,
            metadata: { findings: group },
          }),
        );
        const collapsed = reviewFileCollapsed(fileKey, filesWithFindings, toggledFiles);
        // Everything a card draws from, so the viewer redraws a file's cards when one changes.
        const state = inFile
          .map(({ entry: { key } }) =>
            [
              key,
              key === currentKey ? "c" : "",
              expanded.has(key) ? "e" : "",
              dismissed[key] ? "d" : "",
              ticks.has(key) ? "t" : "",
              ratings.get(key) ?? "",
              sent[key]?.title ?? "",
              busyKeys.has(key) ? "b" : "",
              posted.get(key)?.placement ?? "",
              failures.get(key) ?? "",
            ].join(""),
          )
          .join("|");
        return {
          id: fileKey,
          type: "diff" as const,
          fileDiff,
          annotations,
          collapsed,
          version: fnv1a32(`${collapsed ? "1" : "0"}:${state}`),
        };
      }),
    [
      busyKeys,
      currentKey,
      diff.files,
      dismissed,
      expanded,
      failures,
      filesWithFindings,
      placed,
      posted,
      ratings,
      sent,
      ticks,
      toggledFiles,
    ],
  );
  const selectedLines = useMemo<{ id: string; range: SelectedLineRange } | null>(
    () =>
      currentPlacement === null
        ? null
        : {
            id: currentPlacement.fileKey,
            range: {
              start: currentPlacement.startLine,
              end: currentPlacement.lineNumber,
              side: "additions",
              endSide: "additions",
            },
          },
    [currentPlacement],
  );
  const diffViewOptions = useMemo(
    () => ({
      diffStyle: "unified" as const,
      lineDiffType: "none" as const,
      overflow: settings.wordWrap ? ("wrap" as const) : ("scroll" as const),
      theme: resolveDiffThemeName(resolvedTheme),
      preferredHighlighter: PREFERRED_HIGHLIGHTER,
      themeType: resolvedTheme,
      stickyHeaders: true,
      ...(diff.loadDiffFiles ? { loadDiffFiles: diff.loadDiffFiles } : {}),
    }),
    [diff.loadDiffFiles, resolvedTheme, settings.wordWrap],
  );

  const renderCard = (entry: ReviewFindingEntry, showLocation: boolean) => (
    <ReviewFindingCard
      key={entry.key}
      entry={entry}
      current={entry.key === currentKey}
      expanded={expanded.has(entry.key)}
      dismissed={dismissed[entry.key] === true}
      rating={ratings.get(entry.key)}
      sentTo={sent[entry.key]}
      onOpenSent={openSent}
      showLocation={showLocation}
      {...(commentMode && !posted.has(entry.key)
        ? { ticked: ticks.has(entry.key), onTick: tick }
        : {})}
      onToggleExpanded={toggleExpanded}
      onDismiss={dismiss}
      onRate={canRate ? rate : undefined}
      action={cardAction}
      busy={busyKeys.has(entry.key)}
      posted={posted.get(entry.key)}
      failure={failures.get(entry.key)}
      markdownCwd={cwd}
      threadRef={threadRef ?? reviewThreadRef}
      register={registerCard}
    />
  );
  const renderAnnotation = (annotation: DiffLineAnnotation<FindingAnnotationGroup>) => (
    <div className="py-1">
      {annotation.metadata.findings.map((placement) => renderCard(placement.entry, false))}
    </div>
  );
  const renderHeaderPrefix = useCallback(
    (item: CodeViewItem<FindingAnnotationGroup>) => {
      const collapsed = item.collapsed === true;
      return (
        <Button
          size="icon-micro"
          variant="ghost-muted"
          aria-expanded={!collapsed}
          aria-label={collapsed ? "Expand diff" : "Collapse diff"}
          className="mr-1"
          onClick={(event) => {
            event.stopPropagation();
            toggleFile(item.id);
          }}
        >
          {collapsed ? (
            <ChevronRightIcon className="size-4" />
          ) : (
            <ChevronDownIcon className="size-4" />
          )}
        </Button>
      );
    },
    [toggleFile],
  );

  const tickedKeys = order.filter((key) => ticks.has(key) && !posted.has(key));
  const unposted = openEntries.filter((entry) => !posted.has(entry.key));
  const primary = commentMode
    ? tickedKeys.length > 0
      ? { label: `Post selected (${tickedKeys.length})`, run: () => startPost(tickedKeys) }
      : {
          label: `Post all (${unposted.length})`,
          run: () => startPost(unposted.map((entry) => entry.key)),
        }
    : {
        label: "Fix all",
        run: () =>
          reviewFixAllMode(openEntries.length) === "choose"
            ? setFixing(inIssueOrder(openEntries))
            : void fix(openEntries),
      };
  const postAllWaits = reviewPostAllWaits({
    commentMode,
    tickedCount: tickedKeys.length,
    stillReviewing,
  });
  const primaryDisabled = commentMode
    ? (tickedKeys.length === 0 && unposted.length === 0) || busyKeys.size > 0 || postAllWaits
    : openEntries.length === 0;
  const placedKeys = new Set(placed.map((entry) => entry.entry.key));
  // Fix all lists the issues as the panel does.
  const inIssueOrder = (list: ReadonlyArray<ReviewFindingEntry>) =>
    list.toSorted((left, right) => {
      const rank = (entry: ReviewFindingEntry) => {
        const index = order.indexOf(entry.key);
        return index === -1 ? order.length : index;
      };
      return rank(left) - rank(right);
    });
  const shownByKey = new Map(shown.map((entry) => [entry.key, entry] as const));
  // Files without findings fold to one row; this opens them all, or folds them again.
  const filesWithoutFindings = diff.files.filter((file) => !filesWithFindings.has(file.fileKey));
  const allFilesOpen = diff.files.every((file) => !fileCollapsed(file.fileKey));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
        {stillReviewing ? (
          <Badge variant="info">Still reviewing…</Badge>
        ) : (
          <Badge variant="outline">Latest</Badge>
        )}
        <span className="text-muted-foreground text-xs">
          {openEntries.length === 0
            ? "No issues"
            : `${openEntries.length} ${openEntries.length === 1 ? "issue" : "issues"}`}
        </span>
        {rereviewSummary !== null ? (
          <span className="text-muted-foreground text-xs">· {rereviewSummary}</span>
        ) : null}
        {dismissedCount > 0 ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            aria-pressed={showDismissed}
            onClick={() => setShowDismissed((value) => !value)}
          >
            {dismissedCount} dismissed · {showDismissed ? "hide" : "show"}
          </Button>
        ) : null}
        <span className="ml-auto flex items-center gap-0.5">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Previous issue"
            disabled={order.length === 0}
            onClick={() => goTo(shownIndex === 0 ? order.length - 1 : shownIndex - 1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            Issue {order.length === 0 ? 0 : shownIndex + 1}/{order.length}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Next issue"
            disabled={order.length === 0}
            onClick={() => goTo((shownIndex + 1) % order.length)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </span>
        {filesWithoutFindings.length > 0 ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  aria-pressed={allFilesOpen}
                  aria-label={allFilesOpen ? "Fold files without issues" : "Show all files"}
                  onClick={() =>
                    setToggledFiles(
                      allFilesOpen
                        ? new Set()
                        : new Set(filesWithoutFindings.map((file) => file.fileKey)),
                    )
                  }
                />
              }
            >
              {allFilesOpen ? <FoldVerticalIcon aria-hidden /> : <UnfoldVerticalIcon aria-hidden />}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allFilesOpen ? "Fold files without issues" : "Show all files"}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {startReview ? <FindIssuesButton target={startReview} rereview={rereview} /> : null}
        <Button
          type="button"
          size="xs"
          disabled={primaryDisabled}
          title={postAllWaits ? "Wait for the review to finish" : undefined}
          onClick={primary.run}
        >
          {commentMode ? <MessageSquarePlusIcon aria-hidden /> : <WrenchIcon aria-hidden />}
          {postAllWaits ? "Post all after the review" : primary.label}
        </Button>
      </header>
      <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs">
        <Badge size="sm" variant={REVIEW_VERDICT_BADGES[findings.verdict]}>
          {REVIEW_VERDICT_LABELS[findings.verdict]}
        </Badge>
        <span>
          Merge confidence {findings.mergeConfidence}/5 · Review effort {findings.reviewEffort}/5 ·{" "}
          {reviewedChangeLabel(findings.target, source.scope, diff.base)} · Reviewed by
        </span>
        {source.threadId === threadRef?.threadId ? (
          <span className="min-w-0 truncate text-foreground">{source.threadTitle}</span>
        ) : (
          <Link
            to="/$environmentId/$threadId"
            params={{ environmentId, threadId: source.threadId }}
            className="min-w-0 truncate text-foreground hover:underline"
          >
            {source.threadTitle}
          </Link>
        )}
        <span>· {formatRelativeTimeLabel(source.createdAt)}</span>
      </div>
      {order.length > 0 ? (
        <ol
          aria-label="Issues"
          className="max-h-36 shrink-0 overflow-y-auto border-b border-border/60 py-1"
        >
          {order.map((key, index) => {
            const entry = shownByKey.get(key);
            if (entry === undefined) return null;
            const { finding } = entry;
            return (
              <li key={key}>
                <button
                  type="button"
                  className={cn(
                    "flex w-full min-w-0 items-center gap-2 px-3 py-0.5 text-start text-xs hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring",
                    key === currentKey && "bg-accent/60",
                  )}
                  onClick={() => goTo(index)}
                >
                  <Badge size="sm" variant={REVIEW_SEVERITY_BADGES[finding.severity]}>
                    {REVIEW_FINDING_SEVERITY_LABELS[finding.severity]}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-foreground">{finding.title}</span>
                  <span className="max-w-[45%] shrink-0 truncate text-muted-foreground">
                    {finding.line === undefined ? finding.path : `${finding.path}:${finding.line}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
      {general.length > 0 ? (
        <section
          aria-label="General"
          className="max-h-[40%] shrink-0 overflow-y-auto border-b border-border/60 py-1"
        >
          <h4 className="px-3 pt-1 text-muted-foreground text-xs">General ({general.length})</h4>
          {general.map((entry) => renderCard(entry, true))}
        </section>
      ) : null}
      {diff.partial || diff.error !== null ? (
        <p className="border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs">
          {diff.error !== null
            ? `The change could not be loaded: ${diff.error}`
            : "Part of the change is not shown here. Findings in it are listed under General."}
        </p>
      ) : null}
      <div className="flex min-h-0 flex-1 flex-col">
        {diff.files.length > 0 ? (
          <StyledDiffCodeView<FindingAnnotationGroup>
            className="@container h-full overflow-auto [scrollbar-gutter:stable]"
            viewerRef={setViewer}
            items={items}
            selectedLines={selectedLines}
            onSelectedLinesChange={() => undefined}
            options={diffViewOptions}
            renderHeaderPrefix={renderHeaderPrefix}
            renderAnnotation={renderAnnotation}
          />
        ) : diff.pending ? (
          <p className="px-3 py-2 text-muted-foreground text-sm" role="status">
            Loading the change...
          </p>
        ) : null}
      </div>
      {fixing !== null ? (
        <ReviewFixAllDialog
          entries={fixing}
          sent={sent}
          chatTitle={
            !fixInReviewThread && onFixInChat === undefined ? (panelThread?.title ?? null) : null
          }
          onSend={(selection) => {
            setFixing(null);
            void fix(selection);
          }}
          onClose={() => setFixing(null)}
        />
      ) : null}
      {posting !== null ? (
        <ReviewPostDialog
          pullRequest={
            pullRequestTarget === null || projectId === null
              ? null
              : {
                  environmentId,
                  reference: {
                    projectId,
                    host: pullRequestTarget.host,
                    repository: pullRequestTarget.repository,
                    number: pullRequestTarget.number,
                  },
                }
          }
          reviewedHeadSha={findings.headSha}
          entries={posting}
          verdict={findings.verdict}
          // The server has the last word, from the pull request's own diff; this is the panel's.
          placementOf={(entry) => (placedKeys.has(entry.key) ? "inline" : "body")}
          markdownCwd={cwd}
          onPost={(input) => submitPost(posting, input)}
          onClose={() => setPosting(null)}
        />
      ) : null}
    </div>
  );
}
