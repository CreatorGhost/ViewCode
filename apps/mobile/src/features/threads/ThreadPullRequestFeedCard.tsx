import {
  PR_MERGED_MOMENT_MS,
  PR_MERGE_NEWS_MS,
  prFlowFolded,
} from "@t3tools/client-runtime/pr-flow";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { memo, useEffect, useState } from "react";
import { Alert, Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useNavigateToPullRequest } from "../../native/useOpenPullRequest";
import { useThreadShell } from "../../state/entities";
import { PullRequestDiffStats } from "../pull-requests/PullRequestPresentation";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { PrFlowCard } from "./PrFlowCard";
import { usePullRequestFoldChoice, useThreadPullRequestFlow } from "./useThreadPullRequestFlow";

const FOLDED_STATE = {
  open: { icon: PullRequestGlyph.pullRequest, tint: "accent-adaptive-emerald-600-400" },
  merged: { icon: PullRequestGlyph.merged, tint: "accent-adaptive-violet-600-400" },
  closed: { icon: PullRequestGlyph.closed, tint: "accent-icon-muted" },
} as const;

/**
 * One of the thread's pull requests where the conversation got it, as on web. The current one is
 * the full card; merged, closed and older ones fold to one line that reads nothing. A merge shows
 * its moment and then folds; a merge that is no longer news starts folded. The chevron folds and
 * unfolds for this app session.
 */
export const ThreadPullRequestFeedCard = memo(function ThreadPullRequestFeedCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pullRequestKey: string;
  readonly current: boolean;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(ref);
  const navigateToPullRequest = useNavigateToPullRequest();
  const [choice, setChoice] = usePullRequestFoldChoice(ref, props.pullRequestKey);
  const link =
    visibleThreadPullRequests(shell?.pullRequests ?? []).find(
      (candidate) => threadPullRequestKeyOf(candidate) === props.pullRequestKey,
    ) ?? null;
  const snapshot = link?.snapshot ?? null;
  const state = snapshot?.state ?? "open";
  const mergedAt = snapshot?.mergedAt ? Date.parse(snapshot.mergedAt) : Number.NaN;
  // Read once per mount: a merge that lands while the card is up counts as fresh, and the
  // merged moment's timer folds it; a card mounted later sees how old the merge is.
  const [mountedAt] = useState(Date.now);
  const mergedAgoMs = Number.isFinite(mergedAt) ? mountedAt - mergedAt : null;
  const freshMerge = state === "merged" && mergedAgoMs !== null && mergedAgoMs < PR_MERGE_NEWS_MS;
  const [mergedMomentOver, setMergedMomentOver] = useState(false);
  useEffect(() => {
    if (!freshMerge) return;
    const timer = setTimeout(() => setMergedMomentOver(true), PR_MERGED_MOMENT_MS);
    return () => clearTimeout(timer);
  }, [freshMerge]);
  if (link === null || shell === null) return null;

  const open = (url: string) =>
    void navigateToPullRequest(url, {
      environmentId: String(props.environmentId),
      projectId: String(shell.projectId),
      threadId: String(props.threadId),
    }).then((opened) => {
      if (!opened) Alert.alert("Unable to open PR", "The pull request could not be opened.");
    });
  const folded = prFlowFolded({
    state,
    current: props.current,
    choice,
    mergedAgoMs,
    mergedMomentOver,
  });

  if (folded) {
    const presentation = FOLDED_STATE[state];
    const label =
      state === "merged"
        ? `Merged into ${snapshot?.baseBranch ?? "base"}`
        : state === "closed"
          ? "Closed"
          : "Open";
    const title = snapshot?.title ?? `Pull request #${link.number}`;
    return (
      <View className="mb-4 min-h-11 flex-row items-center rounded-lg border border-border bg-card">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Pull request ${link.number}, ${label}, ${title}`}
          accessibilityHint="Opens the pull request."
          onPress={() => open(link.url)}
          className="min-w-0 flex-1 flex-row items-center gap-2 py-2.5 pl-3 active:opacity-70"
        >
          <SymbolView name={presentation.icon} size={14} tintColorClassName={presentation.tint} />
          <Text className="shrink-0 text-sm font-t3-medium text-foreground">#{link.number}</Text>
          <Text className="shrink-0 text-sm text-foreground-muted">{label}</Text>
          <Text className="min-w-0 flex-1 text-sm text-foreground-tertiary" numberOfLines={1}>
            {title}
          </Text>
          {snapshot?.additions === undefined || snapshot.deletions === undefined ? null : (
            <PullRequestDiffStats
              additions={snapshot.additions}
              deletions={snapshot.deletions}
              compact
            />
          )}
        </Pressable>
        {/* A closed pull request has no card to open into. */}
        {state === "closed" ? (
          <View className="w-3" />
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Expand the pull request card"
            onPress={() => setChoice("expanded")}
            hitSlop={6}
            className="min-h-11 justify-center px-3 active:opacity-70"
          >
            <SymbolView name="chevron.down" size={12} tintColorClassName="accent-icon-muted" />
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <ThreadPullRequestFullCard
      environmentId={props.environmentId}
      threadId={props.threadId}
      pullRequestKey={props.pullRequestKey}
      live={props.current}
      onOpen={open}
      onCollapse={() => setChoice("collapsed")}
    />
  );
});

/** The full card, mounted only while unfolded: the only part that reads the conflicts and checks. */
function ThreadPullRequestFullCard(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pullRequestKey: string;
  readonly live: boolean;
  readonly onOpen: (url: string) => void;
  readonly onCollapse: () => void;
}) {
  const { flow, merge, resolveConflicts } = useThreadPullRequestFlow(
    scopeThreadRef(props.environmentId, props.threadId),
    props.pullRequestKey,
    props.live,
  );
  if (flow === null) return null;
  return (
    <PrFlowCard
      flow={flow}
      live={props.live}
      onCollapse={props.onCollapse}
      onOpen={props.onOpen}
      onResolveConflicts={resolveConflicts}
      onMerge={() =>
        Alert.alert(
          flow.number === null ? "Merge pull request?" : `Merge #${flow.number}?`,
          `${flow.head} merges into ${flow.base ?? "its base"} on the host.`,
          [
            { text: "Cancel", style: "cancel" },
            { text: "Merge", onPress: merge },
          ],
        )
      }
    />
  );
}
