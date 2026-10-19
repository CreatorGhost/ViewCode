import { useAtomValue } from "@effect/atom-react";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { useState } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useProject, useThreadShell } from "../../../state/entities";
import { vcsActionManager } from "../../../state/vcs";
import { usePullRequestActionRunner } from "../../pullRequest/usePullRequestActions";
import { toastManager } from "../../ui/toast";
import { sendReviewFixToChat } from "../reviewFixChat";
import { PrFlowCard } from "./PrFlowCard";
import { type PrFlow, prFlowCreatingPhase, prFlowFromPullRequest } from "./prFlowModel";

/** A merge this recent still gets the whole card, branch map and all; older ones shrink. */
const RECENT_MERGE_MS = 15 * 60_000;

/**
 * The thread's pull request as a PR flow card: while the git menu opens one, then as the host
 * reports it, with Merge and Resolve conflicts. `compact` (the Review panel, or a merge that is
 * no longer news) leaves out the branch map.
 */
export function ThreadPrFlowCard({
  threadRef,
  compact = false,
}: {
  threadRef: ScopedThreadRef;
  compact?: boolean;
}) {
  const { environmentId } = threadRef;
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell === null ? null : scopeProjectRef(environmentId, shell.projectId),
  );
  const gitCwd =
    project === null
      ? null
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: shell?.worktreePath ?? null,
        });
  const action = useAtomValue(vcsActionManager.stateAtom({ environmentId, cwd: gitCwd }));
  const link = resolveThreadCurrentPullRequestLink(
    visibleThreadPullRequests(shell?.pullRequests ?? []),
  );
  const snapshot = link?.snapshot ?? null;
  const reference =
    shell === null || link === null
      ? null
      : {
          projectId: shell.projectId,
          host: link.host,
          repository: link.repository,
          number: link.number,
        };
  const { actionPending, perform } = usePullRequestActionRunner({ environmentId, reference });
  // Asked of the agent for this pull request; it stays asked while the host still reports conflicts.
  const [resolvingNumber, setResolvingNumber] = useState<number | null>(null);
  const nowMinute = useNowMinute();

  const creating =
    action.isRunning && (action.action === "create_pr" || action.action === "commit_push_pr");
  const flow: PrFlow | null = creating
    ? {
        phase: prFlowCreatingPhase(action.currentPhaseLabel ?? action.currentLabel),
        title: shell?.title ?? "Pull request",
        number: null,
        head: shell?.branch ?? "",
        base: null,
        commitCount: null,
        additions: null,
        deletions: null,
        conflicts: null,
        tests: null,
      }
    : link === null || snapshot === null
      ? null
      : prFlowFromPullRequest(
          { number: link.number, ...snapshot },
          { resolving: resolvingNumber === link.number, merging: actionPending },
        );

  if (flow === null || shell === null) return null;
  const mergedAt = snapshot?.mergedAt ? Date.parse(snapshot.mergedAt) : Number.NaN;
  const staleMerge =
    flow.phase === "merged" && !(Date.parse(nowMinute) - mergedAt < RECENT_MERGE_MS);

  const resolveConflicts = async () => {
    if (link === null || snapshot === null) return;
    setResolvingNumber(link.number);
    const sent = await sendReviewFixToChat(threadRef, shell.title, {
      prompt: `Pull request #${link.number} has merge conflicts with ${snapshot.baseBranch}. Merge the latest ${snapshot.baseBranch} into ${snapshot.headBranch}, resolve the conflicts so both sides keep working, run the affected tests, then commit and push.`,
      comments: [],
    });
    if (sent === null) {
      setResolvingNumber(null);
      toastManager.add({
        type: "error",
        title: "Could not ask the agent",
        description: `${shell.title} is not loaded. Open it, then try again.`,
      });
    }
  };

  return (
    <PrFlowCard
      flow={flow}
      compact={compact || staleMerge}
      onResolveConflicts={() => void resolveConflicts()}
      onMerge={() => void perform("merge")}
    />
  );
}
