import { useAtom, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import {
  resolveThreadCurrentPullRequestLink,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { useNowMinute } from "../../../hooks/useNowMinute";
import { useProject, useThreadProjectionSelector, useThreadShell } from "../../../state/entities";
import { pullRequestEnvironment } from "../../../state/pullRequests";
import { useEnvironmentQuery } from "../../../state/query";
import { vcsActionManager, vcsEnvironment } from "../../../state/vcs";
import { usePullRequestActionRunner } from "../../pullRequest/usePullRequestActions";
import { toastManager } from "../../ui/toast";
import { sendReviewFixToChat } from "../reviewFixChat";
import {
  type PrFlow,
  prFlowCreating,
  prFlowFromPullRequest,
  prFlowGitCommandsKey,
  prFlowResolvePrompt,
  prFlowResolvingNumber,
  prFlowRunningCommand,
} from "./prFlowModel";

/** A merge this recent still gets the whole card; older ones shrink and leave the composer. */
const RECENT_MERGE_MS = 15 * 60_000;
/** While the checkout is mid-merge, how often its unresolved files are read again. */
const MERGE_POLL_MS = 10_000;

/**
 * What this client did that the host does not know yet: a merge in flight, and a Resolve click
 * whose message has not reached the thread. Shared by the card and the composer chip.
 */
const prFlowLocalAtom = Atom.family((_threadKey: string) =>
  Atom.make<{
    readonly merging: boolean;
    readonly asked: { readonly number: number; readonly userMessages: number } | null;
  }>({ merging: false, asked: null }).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel("web-pr-flow:local"),
  ),
);

const selectRunningCommand = (thread: EnvironmentThread | null) =>
  thread === null ? null : prFlowRunningCommand(thread.projection);
const selectGitCommandsKey = (thread: EnvironmentThread | null) =>
  thread === null ? "" : prFlowGitCommandsKey(thread.projection);
const selectResolvingNumber = (thread: EnvironmentThread | null) =>
  thread === null ? null : prFlowResolvingNumber(thread.projection);
const selectUserMessages = (thread: EnvironmentThread | null) =>
  thread === null
    ? 0
    : thread.projection.turnItems.reduce(
        (count, item) => count + (item.type === "user_message" ? 1 : 0),
        0,
      );

export interface ThreadPrFlow {
  readonly flow: PrFlow | null;
  /** A merge that is no longer news: header and footer only, and no composer chip. */
  readonly staleMerge: boolean;
  readonly resolveConflicts: () => void;
  readonly merge: () => void;
}

/**
 * The thread's pull request as one flow: the git menu's progress while it opens one, then the
 * host's state, the checkout's commits and conflicts, the host's checks and what the agent is
 * running. `detailed` reads the commits and checks; the compact card does without. `follow`
 * refetches the commits as the agent's git commands finish: one reader per thread does it.
 */
export function useThreadPrFlow(
  threadRef: ScopedThreadRef,
  options: { readonly detailed: boolean; readonly follow: boolean },
): ThreadPrFlow {
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
  const { perform } = usePullRequestActionRunner({ environmentId, reference });
  const [local, setLocal] = useAtom(prFlowLocalAtom(scopedThreadKey(threadRef)));
  const command = useThreadProjectionSelector(threadRef, selectRunningCommand);
  const gitCommandsKey = useThreadProjectionSelector(threadRef, selectGitCommandsKey);
  const resolvingNumber = useThreadProjectionSelector(threadRef, selectResolvingNumber);
  const userMessages = useThreadProjectionSelector(threadRef, selectUserMessages);
  // A Resolve click counts until its message reaches the thread; from then on the thread says it.
  const asked = local.asked;
  const nowMinute = useNowMinute();

  const creating =
    action.isRunning && (action.action === "create_pr" || action.action === "commit_push_pr");
  const mergedAt = snapshot?.mergedAt ? Date.parse(snapshot.mergedAt) : Number.NaN;
  const staleMerge =
    snapshot?.state === "merged" && !(Date.parse(nowMinute) - mergedAt < RECENT_MERGE_MS);
  const detailed =
    options.detailed &&
    !creating &&
    !staleMerge &&
    snapshot !== null &&
    snapshot.state !== "closed" &&
    reference !== null;
  const graphQuery = useEnvironmentQuery(
    detailed && gitCwd !== null && snapshot !== null
      ? pullRequestEnvironment.graph({
          environmentId,
          input: {
            cwd: gitCwd,
            baseBranch: snapshot.baseBranch,
            headBranch: snapshot.headBranch,
          },
        })
      : null,
  );
  const checksQuery = useEnvironmentQuery(
    detailed && reference !== null
      ? pullRequestEnvironment.checks({ environmentId, input: reference })
      : null,
  );
  const statusQuery = useEnvironmentQuery(
    creating && gitCwd !== null
      ? vcsEnvironment.status({ environmentId, input: { cwd: gitCwd } })
      : null,
  );

  // A git command the agent finished can have moved the branch, the base or the merge state.
  const refreshGraph = graphQuery.refresh;
  const lastGitCommandsKey = useRef(gitCommandsKey);
  const follow = options.follow;
  useEffect(() => {
    if (lastGitCommandsKey.current === gitCommandsKey) return;
    lastGitCommandsKey.current = gitCommandsKey;
    if (follow) refreshGraph();
  }, [follow, gitCommandsKey, refreshGraph]);
  const mergeInProgress = graphQuery.data?.resolving != null;
  useEffect(() => {
    if (!follow || !mergeInProgress) return;
    const timer = window.setInterval(refreshGraph, MERGE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [follow, mergeInProgress, refreshGraph]);

  const status = statusQuery.data;
  const flow: PrFlow | null = creating
    ? prFlowCreating({
        title: shell?.title ?? "Pull request",
        head: shell?.branch ?? "",
        stepLabel: action.currentPhaseLabel ?? action.currentLabel,
        commitsToPush:
          status === null
            ? null
            : ((status.hasUpstream ? status.aheadCount : status.aheadOfDefaultCount) ?? null),
      })
    : link === null || snapshot === null
      ? null
      : prFlowFromPullRequest(
          { number: link.number, url: link.url, ...snapshot },
          {
            graph: graphQuery.data ?? null,
            checks: checksQuery.data?.checks ?? null,
            resolveAsked:
              resolvingNumber === link.number ||
              (asked?.number === link.number && asked.userMessages === userMessages),
            merging: local.merging,
            command,
          },
        );

  const resolveConflicts = () => {
    if (link === null || snapshot === null || shell === null) return;
    setLocal((current) => ({ ...current, asked: { number: link.number, userMessages } }));
    void sendReviewFixToChat(threadRef, shell.title, {
      prompt: prFlowResolvePrompt({
        number: link.number,
        base: snapshot.baseBranch,
        head: snapshot.headBranch,
      }),
      comments: [],
    }).then((sent) => {
      if (sent !== null) return;
      setLocal((current) => ({ ...current, asked: null }));
      toastManager.add({
        type: "error",
        title: "Could not ask the agent",
        description: `${shell.title} is not loaded. Open it, then try again.`,
      });
    });
  };

  const merge = () => {
    if (local.merging) return;
    setLocal((current) => ({ ...current, merging: true }));
    void perform("merge").finally(() => setLocal((current) => ({ ...current, merging: false })));
  };

  return { flow, staleMerge, resolveConflicts, merge };
}
