import { diffstatBlocks } from "@t3tools/client-runtime/diff-count";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type PrFlow,
  prFlowChipShown,
  prFlowStatus,
  prFlowTimelinePullRequests,
} from "@t3tools/client-runtime/pr-flow";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { type ReactNode, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { cn } from "../../lib/cn";
import { useProject, useThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { vcsEnvironment } from "../../state/vcs";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { useThreadPullRequestFlow } from "./useThreadPullRequestFlow";

/**
 * Web's chips above the composer (chat/prFlow/ThreadPrFlowCard.tsx `ThreadPrStatusChips`) on the
 * phone: the current pull request's state, or "Create PR" while the branch has work and no open
 * pull request, beside the branch's diff size. Both open the thread's git sheet, where creating a
 * pull request keeps its default-branch prompt.
 */
export function ComposerPullRequestChips(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly onOpenGit?: (() => void) | undefined;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useThreadShell(ref);
  const project = useProject(
    shell === null ? null : scopeProjectRef(props.environmentId, shell.projectId),
  );
  const gitCwd =
    project === null
      ? null
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: shell?.worktreePath ?? null,
        });
  const status = useEnvironmentQuery(
    gitCwd === null
      ? null
      : vcsEnvironment.status({ environmentId: props.environmentId, input: { cwd: gitCwd } }),
  ).data;
  const currentKey =
    shell === null ? null : prFlowTimelinePullRequests(shell.pullRequests).currentKey;
  const branchDiff = status?.branchChanges ?? status?.workingTree ?? null;
  const diff =
    branchDiff === null
      ? null
      : { additions: branchDiff.insertions, deletions: branchDiff.deletions };
  if (currentKey !== null) {
    return (
      <CurrentPullRequestChips
        environmentId={props.environmentId}
        threadId={props.threadId}
        pullRequestKey={currentKey}
        branchDiff={diff}
        onOpenGit={props.onOpenGit}
      />
    );
  }
  const canCreate =
    status != null &&
    status.isRepo &&
    status.refName !== null &&
    !status.isDefaultRef &&
    status.pr?.state !== "open" &&
    (status.hasWorkingTreeChanges || (status.aheadOfDefaultCount ?? status.aheadCount) > 0);
  const hasDiff = diff !== null && diff.additions + diff.deletions > 0;
  if (!canCreate && !hasDiff) return null;
  return (
    <ChipRow>
      {canCreate && props.onOpenGit ? (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens the thread's git controls to create a pull request."
          onPress={props.onOpenGit}
          className="h-[26px] justify-center rounded-full border border-border bg-card px-2.5 active:opacity-70"
        >
          <Text className="text-xs text-foreground-secondary">Create PR</Text>
        </Pressable>
      ) : null}
      {hasDiff && diff ? <DiffChip {...diff} onPress={props.onOpenGit} /> : null}
    </ChipRow>
  );
}

function ChipRow(props: { readonly children: ReactNode }) {
  return <View className="mx-5 mb-2 flex-row flex-wrap gap-1.5">{props.children}</View>;
}

/** Mounted only while the thread has a pull request: the only part that reads its flow. */
function CurrentPullRequestChips(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly pullRequestKey: string;
  readonly branchDiff: { readonly additions: number; readonly deletions: number } | null;
  readonly onOpenGit?: (() => void) | undefined;
}) {
  const { flow } = useThreadPullRequestFlow(
    scopeThreadRef(props.environmentId, props.threadId),
    props.pullRequestKey,
    false,
  );
  // Read once per mount, as the feed card does: a merge older than the news window hides.
  const [mountedAt] = useState(Date.now);
  if (flow === null) return null;
  const mergedAt = flow.mergedAt === null ? Number.NaN : Date.parse(flow.mergedAt);
  const shown = prFlowChipShown({
    state: flow.phase === "merged" ? "merged" : "open",
    mergedAgoMs: Number.isFinite(mergedAt) ? mountedAt - mergedAt : null,
  });
  if (!shown) return null;
  const diff =
    flow.additions !== null && flow.deletions !== null
      ? { additions: flow.additions, deletions: flow.deletions }
      : props.branchDiff;
  return (
    <ChipRow>
      <PrFlowStatusChip flow={flow} />
      {diff !== null && diff.additions + diff.deletions > 0 ? (
        <DiffChip {...diff} onPress={props.onOpenGit} />
      ) : null}
    </ChipRow>
  );
}

const TONE_TEXT = {
  busy: "text-foreground-muted",
  warning: "text-warning-foreground",
  success: "text-adaptive-emerald-600-400",
  merged: "text-adaptive-violet-600-400",
} as const;

function PrFlowStatusChip({ flow }: { flow: PrFlow }) {
  const status = prFlowStatus(flow);
  return (
    <View className="h-[26px] flex-row items-center gap-1.5 rounded-full border border-border bg-card px-2.5">
      {status.tone === "busy" ? (
        <AppActivityIndicator size="small" style={{ width: 12, transform: [{ scale: 0.6 }] }} />
      ) : status.tone === "merged" ? (
        <SymbolView
          name={PullRequestGlyph.merged}
          size={11}
          tintColorClassName="accent-adaptive-violet-600-400"
        />
      ) : (
        <View
          className={cn(
            "size-1.5 rounded-full",
            status.tone === "warning" ? "bg-warning-foreground" : "bg-adaptive-emerald-600-400",
          )}
        />
      )}
      {flow.number === null ? null : (
        <Text className="text-xs text-foreground">#{flow.number}</Text>
      )}
      <Text
        className={cn("text-xs", flow.number === null ? "text-foreground" : TONE_TEXT[status.tone])}
      >
        {status.short}
      </Text>
    </View>
  );
}

const DIFFSTAT_TONE = {
  addition: "bg-adaptive-emerald-600-400",
  deletion: "bg-danger-foreground",
  neutral: "bg-subtle-strong",
} as const;

function DiffChip(props: {
  readonly additions: number;
  readonly deletions: number;
  readonly onPress?: (() => void) | undefined;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.additions} lines added, ${props.deletions} removed`}
      accessibilityHint="Opens the thread's git controls."
      disabled={props.onPress === undefined}
      onPress={props.onPress}
      className="h-[26px] flex-row items-center gap-1.5 rounded-full border border-border bg-card pr-2 pl-2.5 active:opacity-70"
    >
      <Text className="text-xs text-adaptive-emerald-600-400">+{props.additions}</Text>
      <Text className="text-xs text-danger-foreground">−{props.deletions}</Text>
      <View className="flex-row gap-0.5">
        {diffstatBlocks(props.additions, props.deletions).map((block, index) => (
          // Five fixed slots, never reordered.
          // oxlint-disable-next-line react/no-array-index-key
          <View key={index} className={cn("size-1.5 rounded-[1.5px]", DIFFSTAT_TONE[block])} />
        ))}
      </View>
      {props.onPress ? (
        <SymbolView name="chevron.down" size={9} tintColorClassName="accent-icon-muted" />
      ) : null}
    </Pressable>
  );
}
