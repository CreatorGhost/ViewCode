import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import type { TimelinePullRequest } from "../MessagesTimeline";

import { ChevronDownIcon } from "lucide-react";

import { useOpenLink } from "~/browser/useOpenLink";
import { cn } from "~/lib/utils";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import GitActionsControl from "../../GitActionsControl";
import { useLocalStorage } from "~/hooks/useLocalStorage";
import { useNowMinute } from "~/hooks/useNowMinute";
import { observeChipGlide } from "~/lib/chipGlide";
import { useThreadShell } from "~/state/entities";
import { FoldFrame } from "../../ui/fold-frame";
import { PrFlowCard, PrFlowCollapsedRow } from "./PrFlowCard";
import {
  PR_MERGED_MOMENT_MS,
  PR_MERGE_NEWS_MS,
  prFlowChipShown,
  prFlowFolded,
  prFlowReached,
  prFlowTimelinePullRequests,
} from "@t3tools/client-runtime/pr-flow";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { PrFlowStatusChip } from "./PrFlowStatusChip";
import { useThreadPrFlow } from "./useThreadPrFlow";
import { diffstatBlocks } from "@t3tools/client-runtime/diff-count";

/**
 * The thread's current pull request as a compact card (header and footer), for the Review
 * panel: while the git menu opens one, then from the host, with Resolve conflicts and Merge.
 */
export function ThreadPrFlowCard({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { flow, resolveConflicts, merge } = useThreadPrFlow(threadRef, {
    pullRequest: "current",
    detailed: false,
    follow: false,
  });
  const openLink = useOpenLink(threadRef);
  if (flow === null) return null;
  return (
    <PrFlowCard
      flow={flow}
      compact
      onResolveConflicts={resolveConflicts}
      onMerge={merge}
      onOpen={(url) => void openLink(url)}
    />
  );
}

/**
 * The card while the git menu opens a pull request the thread has no link for yet: at the end of
 * the chat, until the link arrives and the card takes its place in the conversation.
 */
export function ThreadPrCreatingCard({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { flow, creating } = useThreadPrFlow(threadRef, {
    pullRequest: "current",
    detailed: false,
    follow: false,
  });
  const threadKey = scopedThreadKey(threadRef);
  const shownKeys =
    creating && flow !== null
      ? [
          ...(prFlowReached(flow.phase, "opening") ? ["target"] : []),
          ...flow.rows.map((row) => row.key),
        ].join("\n")
      : null;
  useEffect(() => {
    if (shownKeys !== null)
      creatingRowsByThread.set(threadKey, { keys: shownKeys, at: Date.now() });
  }, [shownKeys, threadKey]);
  if (!creating || flow === null) return null;
  // News: it rises in, and its rows arrive one after another as the graph loads.
  return <PrFlowCard flow={flow} appear />;
}

/**
 * The rows the creating card last showed, per thread. The pull request's own card takes its
 * place when the link arrives; it reads these once, so the rows already on screen stay put and
 * only what is new opens in, instead of the whole card arriving again.
 */
const creatingRowsByThread = new Map<string, { readonly keys: string; readonly at: number }>();
const CREATING_HANDOFF_MS = 30_000;

// Read, not taken: React may run a state initializer twice, and a remount within the window
// keying the same rows is harmless.
function creatingRowsShown(threadKey: string): ReadonlyArray<string> | undefined {
  const entry = creatingRowsByThread.get(threadKey);
  if (entry === undefined || Date.now() - entry.at > CREATING_HANDOFF_MS) return undefined;
  return entry.keys.length === 0 ? [] : entry.keys.split("\n");
}

/** How long after the conversation got a pull request its card still arrives as news. */
const PR_APPEAR_WINDOW_MS = 90_000;

const FoldChoice = Schema.NullOr(Schema.Literals(["expanded", "collapsed"]));
const foldStorageKey = (threadRef: ScopedThreadRef, pullRequestKey: string) =>
  `viewcode:pr-card-fold:${threadRef.environmentId}:${threadRef.threadId}:${pullRequestKey}`;

/**
 * One of the thread's pull requests, where the conversation got it. The current one is the live
 * card; merged, closed and older ones fold to one line that reads nothing. A merge plays its
 * moment and then folds; a merge that is no longer news starts folded. The chevron folds and
 * unfolds, remembered per pull request.
 */
export function ThreadPrTimelineCard({
  threadRef,
  pullRequestKey,
}: {
  threadRef: ScopedThreadRef;
  pullRequestKey: string;
}) {
  const shell = useThreadShell(threadRef);
  const openLink = useOpenLink(threadRef);
  const nowMinute = useNowMinute();
  const [choice, setChoice] = useLocalStorage(
    foldStorageKey(threadRef, pullRequestKey),
    null,
    FoldChoice,
  );
  const links = shell?.pullRequests ?? [];
  const link =
    visibleThreadPullRequests(links).find(
      (candidate) => threadPullRequestKeyOf(candidate) === pullRequestKey,
    ) ?? null;
  const snapshot = link?.snapshot ?? null;
  const state = snapshot?.state ?? "open";
  const mergedAt = snapshot?.mergedAt ? Date.parse(snapshot.mergedAt) : Number.NaN;
  const mergedAgoMs = Number.isFinite(mergedAt) ? Date.parse(nowMinute) - mergedAt : null;
  const freshMerge = state === "merged" && mergedAgoMs !== null && mergedAgoMs < PR_MERGE_NEWS_MS;
  const [mergedMomentOver, setMergedMomentOver] = useState(false);
  useEffect(() => {
    if (!freshMerge) return;
    const timer = window.setTimeout(() => setMergedMomentOver(true), PR_MERGED_MOMENT_MS);
    return () => window.clearTimeout(timer);
  }, [freshMerge]);
  // A card the conversation got moments ago is news and opens in; one restored on a later
  // visit is already there. Decided once, so a re-render never replays it. The minute clock is
  // the component's only clock, so the window is wide enough to absorb its granularity.
  const [appear] = useState(
    () => link !== null && Date.parse(nowMinute) - Date.parse(link.linkedAt) < PR_APPEAR_WINDOW_MS,
  );
  // Taken only by the current pull request: the one the creating card was opening.
  const [continuesFrom] = useState(() =>
    prFlowTimelinePullRequests(links).currentKey === pullRequestKey
      ? creatingRowsShown(scopedThreadKey(threadRef))
      : undefined,
  );
  if (link === null) return null;
  const current = prFlowTimelinePullRequests(links).currentKey === pullRequestKey;
  const folded = prFlowFolded({ state, current, choice, mergedAgoMs, mergedMomentOver });
  const onOpen = (url: string) => void openLink(url);
  return (
    <FoldFrame
      folded={folded}
      collapsed={
        <PrFlowCollapsedRow
          number={link.number}
          state={state}
          title={snapshot?.title ?? `Pull request #${link.number}`}
          base={snapshot?.baseBranch ?? null}
          additions={snapshot?.additions ?? null}
          deletions={snapshot?.deletions ?? null}
          url={link.url}
          onOpen={onOpen}
          // A closed pull request has no card to open into.
          onExpand={state === "closed" ? undefined : () => setChoice("expanded")}
        />
      }
      full={
        <ThreadPrTimelineFullCard
          threadRef={threadRef}
          pullRequestKey={pullRequestKey}
          live={current}
          appear={appear && continuesFrom === undefined}
          continuesFrom={continuesFrom}
          onOpen={onOpen}
          onCollapse={() => setChoice("collapsed")}
        />
      }
    />
  );
}

/** The full card, mounted only while unfolded: the only part that reads the graph and checks. */
function ThreadPrTimelineFullCard({
  threadRef,
  pullRequestKey,
  live,
  appear,
  continuesFrom,
  onOpen,
  onCollapse,
}: {
  threadRef: ScopedThreadRef;
  pullRequestKey: string;
  live: boolean;
  appear: boolean;
  continuesFrom: ReadonlyArray<string> | undefined;
  onOpen: (url: string) => void;
  onCollapse: () => void;
}) {
  const { flow, resolveConflicts, merge } = useThreadPrFlow(threadRef, {
    pullRequest: pullRequestKey,
    detailed: true,
    follow: live,
  });
  if (flow === null) return null;
  return (
    <PrFlowCard
      flow={flow}
      live={live}
      appear={appear}
      continuesFrom={continuesFrom}
      onCollapse={onCollapse}
      onResolveConflicts={resolveConflicts}
      onMerge={merge}
      onOpen={onOpen}
    />
  );
}

/**
 * The chips above the composer: the current pull request's state, or "Create PR" while the git
 * menu would open one, beside the branch's diff size. Gone when there is nothing to say.
 */
export function ThreadPrStatusChips({ threadRef }: { threadRef: ScopedThreadRef }) {
  // The live card in the conversation follows the agent; the chip reads what it fetched.
  const { flow, gitCwd } = useThreadPrFlow(threadRef, {
    pullRequest: "current",
    detailed: true,
    follow: false,
  });
  const nowMinute = useNowMinute();
  const statusQuery = useEnvironmentQuery(
    gitCwd === null
      ? null
      : vcsEnvironment.status({ environmentId: threadRef.environmentId, input: { cwd: gitCwd } }),
  );
  const mergedAt = flow?.mergedAt == null ? Number.NaN : Date.parse(flow.mergedAt);
  const shown =
    flow !== null &&
    prFlowChipShown({
      state: flow.phase === "merged" ? "merged" : "open",
      mergedAgoMs: Number.isFinite(mergedAt) ? Date.parse(nowMinute) - mergedAt : null,
    });
  const status = statusQuery.data;
  const branchDiff = status?.branchChanges ?? status?.workingTree ?? null;
  const diff =
    shown && flow.additions !== null && flow.deletions !== null
      ? { additions: flow.additions, deletions: flow.deletions }
      : branchDiff === null
        ? null
        : { additions: branchDiff.insertions, deletions: branchDiff.deletions };
  const hasDiff = diff !== null && diff.additions + diff.deletions > 0;
  if (!shown && (gitCwd === null || !hasDiff)) return null;
  return (
    <div ref={observeChipGlide} className="pointer-events-none relative flex gap-1.5 pb-2">
      {shown ? (
        <PrFlowStatusChip flow={flow} />
      ) : (
        <GitActionsControl
          presentation="composer-chip"
          gitCwd={gitCwd}
          activeThreadRef={threadRef}
          renderComposerChip={(action) => (
            <CreatePrChip label={action.label} disabled={action.disabled} onClick={action.run} />
          )}
        />
      )}
      {hasDiff ? (
        <DiffChip
          additions={diff.additions}
          deletions={diff.deletions}
          onOpen={() => useRightPanelStore.getState().open(threadRef, "diff")}
        />
      ) : null}
    </div>
  );
}

const DIFFSTAT_TONE = {
  addition: "bg-diff-addition-foreground",
  deletion: "bg-diff-deletion-foreground",
  neutral: "bg-muted-foreground/30",
} as const;

/** Opens a pull request for the branch, as the git menu's quick action does. */
export function CreatePrChip({
  label,
  disabled = false,
  onClick,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="pointer-events-auto flex h-6.5 items-center rounded-full border bg-card px-2.5 text-xs whitespace-nowrap text-foreground/85 outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:opacity-50"
      disabled={disabled}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

/** The branch's size, with GitHub's five blocks; it opens the diff. */
export function DiffChip({
  additions,
  deletions,
  onOpen,
}: {
  additions: number;
  deletions: number;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      aria-label={`${additions} lines added, ${deletions} removed. Show the diff`}
      className="pointer-events-auto flex h-6.5 items-center gap-1.5 rounded-full border bg-card ps-2.5 pe-1.5 font-mono text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      onClick={onOpen}
    >
      <span className="text-diff-addition-foreground">+{additions}</span>
      <span className="text-diff-deletion-foreground">−{deletions}</span>
      <span aria-hidden className="flex gap-0.5">
        {diffstatBlocks(additions, deletions).map((block, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- five fixed slots
          <span key={index} className={cn("size-1.5 rounded-xs", DIFFSTAT_TONE[block])} />
        ))}
      </span>
      <ChevronDownIcon aria-hidden className="size-3.5 text-muted-foreground" />
    </button>
  );
}

const NO_PULL_REQUESTS: ReadonlyArray<TimelinePullRequest> = [];

/**
 * The thread's pull requests for the timeline, the same array until one is added or re-anchored,
 * so the shell's other updates do not re-render the conversation.
 */
export function useThreadTimelinePullRequests(
  threadRef: ScopedThreadRef | null,
): ReadonlyArray<TimelinePullRequest> {
  const shell = useThreadShell(threadRef);
  const next = prFlowTimelinePullRequests(shell?.pullRequests ?? []).pullRequests;
  const signature = next.map((entry) => `${entry.key}\0${entry.anchorAt}`).join("\n");
  const [state, setState] = useState({ signature: "", value: NO_PULL_REQUESTS });
  if (state.signature === signature) return state.value;
  setState({ signature, value: next });
  return next;
}
