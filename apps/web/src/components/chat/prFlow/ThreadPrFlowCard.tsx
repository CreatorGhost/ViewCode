import type { ScopedThreadRef } from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Schema from "effect/Schema";
import { useEffect, useState } from "react";

import type { TimelinePullRequest } from "../MessagesTimeline";

import { useOpenLink } from "~/browser/useOpenLink";
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
  prFlowTimelinePullRequests,
} from "./prFlowModel";
import { PrFlowStatusChip } from "./PrFlowStatusChip";
import { useThreadPrFlow } from "./useThreadPrFlow";

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
  if (!creating || flow === null) return null;
  return <PrFlowCard flow={flow} />;
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
          appear={appear}
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
  onOpen,
  onCollapse,
}: {
  threadRef: ScopedThreadRef;
  pullRequestKey: string;
  live: boolean;
  appear: boolean;
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
      onCollapse={onCollapse}
      onResolveConflicts={resolveConflicts}
      onMerge={merge}
      onOpen={onOpen}
    />
  );
}

/**
 * The current pull request's state above the composer, beside its diff size. Gone once it is
 * closed, or merged and no longer news.
 */
export function ThreadPrStatusChips({ threadRef }: { threadRef: ScopedThreadRef }) {
  // The live card in the conversation follows the agent; the chip reads what it fetched.
  const { flow } = useThreadPrFlow(threadRef, {
    pullRequest: "current",
    detailed: true,
    follow: false,
  });
  const nowMinute = useNowMinute();
  if (flow === null) return null;
  const mergedAt = flow.mergedAt === null ? Number.NaN : Date.parse(flow.mergedAt);
  const shown = prFlowChipShown({
    state: flow.phase === "merged" ? "merged" : "open",
    mergedAgoMs: Number.isFinite(mergedAt) ? Date.parse(nowMinute) - mergedAt : null,
  });
  if (!shown) return null;
  return (
    <div ref={observeChipGlide} className="pointer-events-none relative flex gap-1.5 pb-2">
      <PrFlowStatusChip flow={flow} />
      {flow.additions === null || flow.deletions === null ? null : (
        <span className="flex h-6.5 items-center gap-1.5 rounded-full border bg-card px-2.5 font-mono text-xs">
          <span className="text-diff-addition-foreground">+{flow.additions}</span>
          <span className="text-diff-deletion-foreground">−{flow.deletions}</span>
        </span>
      )}
    </div>
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
