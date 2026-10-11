import type { CodeViewItem, DiffLineAnnotation, SelectedLineRange } from "@pierre/diffs";
import type { CodeViewDiffItem, CodeViewHandle } from "@pierre/diffs/react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ProjectId,
  PullRequestReviewVerdict,
  PullRequestStartReviewResult,
  ReviewFindingsTarget,
  ReviewVerdict,
  ScopedThreadRef,
} from "@t3tools/contracts";
import {
  type PostedReviewFinding,
  REVIEW_VERDICT_LABELS,
  reviewFindingsMode,
} from "@t3tools/shared/reviewFindings";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/shared/threadPullRequests";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ListChecksIcon,
  MessageSquarePlusIcon,
  WrenchIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useTheme } from "~/hooks/useTheme";
import { fnv1a32, resolveDiffThemeName } from "~/lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "~/lib/syntaxHighlighting";
import { useServerConfigs } from "../../state/entities";
import { reviewEnvironment } from "../../state/review";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import { StyledDiffCodeView } from "../diffs/StyledDiffCodeView";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { toastManager } from "../ui/toast";
import { type ReviewFindingAction, ReviewFindingCard } from "./ReviewFindingCard";
import { ReviewFixDialog, type ReviewFixItem } from "./ReviewFixDialog";
import { ReviewPostDialog } from "./ReviewPostDialog";
import { FindIssuesButton, ReviewStartForm, type ReviewStartTarget } from "./ReviewStart";
import {
  placeReviewFindings,
  type PlacedReviewFinding,
  reviewFindingEntries,
  type ReviewFindingEntry,
  type ReviewFindingKey,
  type ReviewFindingsSource,
  reviewFindingsFixPrompt,
} from "./reviewPanel.logic";
import {
  type ReviewFindingRating,
  type ReviewFixDestination,
  useReviewFixSentStore,
} from "./reviewFixSentStore";
import { useReviewDiff } from "./useReviewDiff";
import { useReviewFindingsSource } from "./useReviewFindingsSource";

export const REVIEW_VERDICT_BADGES: Record<ReviewVerdict, "success" | "info" | "warning"> = {
  approve: "success",
  "approve-with-nits": "info",
  "request-changes": "warning",
};

/** A request for this thread's composer and the chip records its text refers to. */
export type ReviewFixInChatRequest = ReturnType<typeof reviewFindingsFixPrompt>;

interface FindingAnnotationGroup {
  readonly findings: ReadonlyArray<PlacedReviewFinding>;
}

const EMPTY_SENT: Readonly<Record<string, ReviewFixDestination>> = {};
const EMPTY_DISMISSED: Readonly<Record<string, true>> = {};
const EMPTY_RATINGS: Readonly<Record<string, ReviewFindingRating>> = {};

function targetLabel(target: ReviewFindingsTarget): string {
  return target.kind === "pull-request" ? `PR #${target.number}` : "Local changes";
}

function fixItem(entry: ReviewFindingEntry): ReviewFixItem {
  return { key: entry.key, item: { finding: entry.finding, needsChecking: entry.needsChecking } };
}

/**
 * One set of findings over the change it reviewed: a toolbar to walk and act on them, who
 * reviewed it and when, the findings no line of the diff can carry, then the diff with every other
 * finding under its lines. Unchanged regions stay folded the way the diff viewer folds them.
 */
interface ReviewFindingsViewProps {
  readonly threadRef: ScopedThreadRef;
  readonly source: ReviewFindingsSource;
  readonly projectId: ProjectId | null;
  readonly cwd: string | undefined;
  readonly posted: ReadonlyMap<string, PostedReviewFinding>;
  readonly onFixInChat: ((request: ReviewFixInChatRequest) => void) | undefined;
  /** Where a new review of the pull request starts, when one can. */
  readonly startReview: ReviewStartTarget | null;
}

function postedEqual(
  left: ReadonlyMap<string, PostedReviewFinding>,
  right: ReadonlyMap<string, PostedReviewFinding>,
): boolean {
  if (left.size !== right.size) return false;
  for (const [key, entry] of left) {
    const other = right.get(key);
    if (other?.placement !== entry.placement || other.url !== entry.url) return false;
  }
  return true;
}

// The source and the posted record are recomputed whenever any thread changes; the view only
// cares when what they say does, and a redraw would rebuild every annotation in the diff.
const ReviewFindingsView = memo(
  ReviewFindingsViewContent,
  (previous, next) =>
    previous.threadRef === next.threadRef &&
    previous.projectId === next.projectId &&
    previous.cwd === next.cwd &&
    previous.onFixInChat === next.onFixInChat &&
    previous.startReview === next.startReview &&
    previous.source.activityId === next.source.activityId &&
    previous.source.threadTitle === next.source.threadTitle &&
    postedEqual(previous.posted, next.posted),
);

function ReviewFindingsViewContent({
  threadRef,
  source,
  projectId,
  cwd,
  posted,
  onFixInChat,
  startReview,
}: ReviewFindingsViewProps) {
  const { findings } = source;
  const { environmentId } = threadRef;
  const reviewThreadRef = useMemo(
    () => scopeThreadRef(environmentId, source.threadId),
    [environmentId, source.threadId],
  );
  const cardKey = `${environmentId}:${source.activityId}`;
  const sent = useReviewFixSentStore((state) => state.sentByCard[cardKey] ?? EMPTY_SENT);
  const dismissed = useReviewFixSentStore(
    (state) => state.dismissedByCard[cardKey] ?? EMPTY_DISMISSED,
  );
  const ratings = useReviewFixSentStore((state) => state.ratingByCard[cardKey] ?? EMPTY_RATINGS);
  const [showDismissed, setShowDismissed] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  const [ticks, setTicks] = useState<ReadonlySet<ReviewFindingKey>>(() => new Set());
  const [currentKey, setCurrentKey] = useState<ReviewFindingKey | null>(null);
  const [toggledFiles, setToggledFiles] = useState<ReadonlySet<string>>(() => new Set());
  const [fixing, setFixing] = useState<ReadonlyArray<ReviewFixItem> | null>(null);
  const [viewer, setViewer] = useState<CodeViewHandle<FindingAnnotationGroup> | null>(null);
  const generalRef = useRef<HTMLDivElement | null>(null);
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();

  const diff = useReviewDiff({
    environmentId,
    target: findings.target,
    projectId,
    cwd: cwd ?? null,
  });
  const entries = useMemo(() => reviewFindingEntries(findings), [findings]);
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
  const order = useMemo(
    () => [...general.map((entry) => entry.key), ...placed.map((entry) => entry.entry.key)],
    [general, placed],
  );
  const openEntries = entries.filter((entry) => !dismissed[entry.key]);
  const currentIndex = currentKey === null ? -1 : order.indexOf(currentKey);
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
  const rateFor = useReviewFixSentStore((state) => state.rate);
  const dismiss = useCallback(
    (key: ReviewFindingKey, value: boolean) => setDismissedFor(cardKey, key, value),
    [cardKey, setDismissedFor],
  );
  const rate = useCallback(
    (key: ReviewFindingKey, rating: ReviewFindingRating) => rateFor(cardKey, key, rating),
    [cardKey, rateFor],
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
  // Fixing happens in the chat beside the panel, as a request the reader sends themselves; the
  // review thread itself does not fix (reviewers do not), so there it picks a session instead.
  const fixInReviewThread = source.threadId === threadRef.threadId;
  const fix = useCallback(
    (selection: ReadonlyArray<ReviewFindingEntry>) => {
      if (selection.length === 0) return;
      if (fixInReviewThread || onFixInChat === undefined) {
        setFixing(selection.map(fixItem));
        return;
      }
      onFixInChat(reviewFindingsFixPrompt({ activityId: source.activityId, entries: selection }));
    },
    [fixInReviewThread, onFixInChat, source.activityId],
  );
  const cardAction = useMemo<ReviewFindingAction>(
    () =>
      commentMode
        ? { kind: "post", label: "Post comment", run: (key) => startPost([key]) }
        : {
            kind: "fix",
            label: "Fix with agent",
            run: (key) => fix(entries.filter((candidate) => candidate.key === key)),
          },
    [commentMode, entries, fix, startPost],
  );

  const filesWithFindings = useMemo(() => new Set(placed.map((entry) => entry.fileKey)), [placed]);
  // Files with findings open and the rest fold, until the reader says otherwise.
  const fileCollapsed = (fileKey: string) =>
    filesWithFindings.has(fileKey) === toggledFiles.has(fileKey);
  const toggleFile = useCallback(
    (fileKey: string) =>
      setToggledFiles((current) => {
        const next = new Set(current);
        if (!next.delete(fileKey)) next.add(fileKey);
        return next;
      }),
    [],
  );

  const goTo = (index: number) => {
    const key = order[index];
    if (key === undefined) return;
    setCurrentKey(key);
    const placement = placed.find((entry) => entry.entry.key === key);
    // A folded file opens so its finding can be shown.
    if (placement && fileCollapsed(placement.fileKey)) toggleFile(placement.fileKey);
  };
  // Scrolls once the viewer has drawn the finding's file open.
  useEffect(() => {
    if (currentKey === null) return;
    if (currentPlacement === null) {
      generalRef.current
        ?.querySelector(`[data-review-finding="${currentKey}"]`)
        ?.scrollIntoView({ block: "nearest" });
      return;
    }
    viewer?.scrollTo({
      type: "range",
      id: currentPlacement.fileKey,
      range: {
        start: currentPlacement.startLine,
        end: currentPlacement.lineNumber,
        side: "additions",
        endSide: "additions",
      },
      align: "center",
    });
  }, [currentKey, currentPlacement, viewer]);

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
        const collapsed = filesWithFindings.has(fileKey) === toggledFiles.has(fileKey);
        // Everything a card draws from, so the viewer redraws a file's cards when one changes.
        const state = inFile
          .map(({ entry: { key } }) =>
            [
              key,
              key === currentKey ? "c" : "",
              expanded.has(key) ? "e" : "",
              dismissed[key] ? "d" : "",
              ticks.has(key) ? "t" : "",
              ratings[key] ?? "",
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
      rating={ratings[entry.key]}
      sentTo={sent[entry.key]}
      showLocation={showLocation}
      {...(commentMode && !posted.has(entry.key)
        ? { ticked: ticks.has(entry.key), onTick: tick }
        : {})}
      onToggleExpanded={toggleExpanded}
      onDismiss={dismiss}
      onRate={rate}
      action={cardAction}
      busy={busyKeys.has(entry.key)}
      posted={posted.get(entry.key)}
      failure={failures.get(entry.key)}
      markdownCwd={cwd}
      threadRef={threadRef}
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
    : { label: "Fix all", run: () => fix(openEntries) };
  const primaryDisabled = commentMode
    ? (tickedKeys.length === 0 && unposted.length === 0) || busyKeys.size > 0
    : openEntries.length === 0;
  const placedKeys = new Set(placed.map((entry) => entry.entry.key));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-1.5">
        <Badge variant="outline">Latest</Badge>
        <span className="text-muted-foreground text-xs">
          {openEntries.length === 0
            ? "No issues found"
            : `${openEntries.length} ${openEntries.length === 1 ? "issue" : "issues"} found`}
        </span>
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
            onClick={() => goTo(currentIndex <= 0 ? order.length - 1 : currentIndex - 1)}
          >
            <ChevronLeftIcon aria-hidden />
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            Issue {currentIndex < 0 ? "-" : currentIndex + 1}/{order.length}
          </span>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            aria-label="Next issue"
            disabled={order.length === 0}
            onClick={() => goTo(currentIndex < 0 ? 0 : (currentIndex + 1) % order.length)}
          >
            <ChevronRightIcon aria-hidden />
          </Button>
        </span>
        {startReview ? <FindIssuesButton target={startReview} /> : null}
        <Button type="button" size="xs" disabled={primaryDisabled} onClick={primary.run}>
          {commentMode ? <MessageSquarePlusIcon aria-hidden /> : <WrenchIcon aria-hidden />}
          {primary.label}
        </Button>
      </header>
      <div className="flex min-w-0 flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs">
        <Badge size="sm" variant={REVIEW_VERDICT_BADGES[findings.verdict]}>
          {REVIEW_VERDICT_LABELS[findings.verdict]}
        </Badge>
        <span>
          Merge confidence {findings.mergeConfidence}/5 · Review effort {findings.reviewEffort}/5 ·{" "}
          {targetLabel(findings.target)} · Reviewed by
        </span>
        {source.threadId === threadRef.threadId ? (
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
      {general.length > 0 ? (
        <section
          ref={generalRef}
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
        <ReviewFixDialog
          reviewThreadRef={reviewThreadRef}
          cardKey={cardKey}
          target={findings.target}
          items={fixing}
          onClose={() => setFixing(null)}
        />
      ) : null}
      {posting !== null ? (
        <ReviewPostDialog
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

/**
 * The Review surface of the right panel: the latest findings for this thread (its own, or those
 * of the newest review of its pull request) over the change they are about. Findings for fixing
 * go to this thread's composer (`onFixInChat`); findings for somebody else's pull request are
 * posted to it as review comments.
 */
export function ReviewPanel({
  threadRef,
  cwd,
  onFixInChat,
}: {
  threadRef: ScopedThreadRef;
  /** The thread's checkout: where a local review's change is read, and file links resolve. */
  cwd: string | undefined;
  onFixInChat?: ((request: ReviewFixInChatRequest) => void) | undefined;
}) {
  const { source, posted, pullRequests, projectId } = useReviewFindingsSource(threadRef);
  const navigate = useNavigate();
  const { environmentId } = threadRef;
  const canStartReview =
    useServerConfigs().get(environmentId)?.environment.capabilities.pullRequestAgentReview === true;
  // A review started from here keeps this thread open; its findings arrive here once it
  // submits them, since it is linked to the same pull request.
  const [started, setStarted] = useState<PullRequestStartReviewResult | null>(null);
  const pullRequest = resolveThreadCurrentPullRequestLink(pullRequests);
  const host = pullRequest?.host;
  const repository = pullRequest?.repository;
  const number = pullRequest?.number;
  const startReview = useMemo<ReviewStartTarget | null>(
    () =>
      canStartReview &&
      projectId !== null &&
      host !== undefined &&
      repository !== undefined &&
      number !== undefined
        ? {
            environmentId,
            reference: { projectId, host, repository, number },
            onStarted: (review) => {
              setStarted(review);
              toastManager.add({
                type: "success",
                title: "Review started",
                description: "Its findings appear in this panel when it is done.",
                actionProps: {
                  children: "Open review",
                  onClick: () => {
                    void navigate({
                      to: "/$environmentId/$threadId",
                      params: { environmentId, threadId: review.threadId },
                    });
                  },
                },
              });
            },
          }
        : null,
    [canStartReview, environmentId, host, navigate, number, projectId, repository],
  );
  if (source === null) {
    return (
      <Empty size="compact">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ListChecksIcon />
          </EmptyMedia>
          <EmptyTitle>No review findings yet</EmptyTitle>
          <EmptyDescription>
            {started !== null ? (
              <>
                <Link
                  to="/$environmentId/$threadId"
                  params={{ environmentId, threadId: started.threadId }}
                  className="text-foreground hover:underline"
                >
                  {started.title}
                </Link>{" "}
                is under way. Its findings appear here when it is done.
              </>
            ) : startReview !== null ? (
              `Have an agent review PR #${startReview.reference.number}; its findings appear here.`
            ) : (
              "Link a pull request to this thread to have an agent review it here."
            )}
          </EmptyDescription>
        </EmptyHeader>
        {startReview !== null && started === null ? (
          <EmptyContent>
            <ReviewStartForm target={startReview} />
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  return (
    // A re-review starts fresh rather than keeping the previous set's view.
    <ReviewFindingsView
      key={`${source.threadId}:${source.activityId}`}
      threadRef={threadRef}
      source={source}
      projectId={projectId}
      cwd={cwd}
      posted={posted}
      onFixInChat={onFixInChat}
      startReview={startReview}
    />
  );
}
