import { useAtom, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThread } from "@t3tools/client-runtime/state/models";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import {
  resolveThreadCurrentPullRequestLink,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { Atom } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { useNowMinute } from "~/hooks/useNowMinute";

import { useProject, useThreadProjectionSelector, useThreadShell } from "../../../state/entities";
import { pullRequestEnvironment } from "../../../state/pullRequests";
import { useEnvironmentQuery } from "../../../state/query";
import { vcsActionManager, vcsEnvironment } from "../../../state/vcs";
import {
  usePullRequestActionRunner,
  usePullRequestMergeMethodResolver,
} from "../../pullRequest/usePullRequestActions";
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
} from "@t3tools/client-runtime/pr-flow";

/** While the checkout is mid-merge, how often its unresolved files are read again. */
const MERGE_POLL_MS = 10_000;
/** How long after the thread got a pull request an unknown mergeability reads as "checking". */
const JUST_OPENED_MS = 2 * 60_000;

/** `origin/main` → `main`: the branch name the graph and the host use. */
function branchOfRef(ref: string | null | undefined): string | null {
  if (!ref) return null;
  const slash = ref.indexOf("/");
  return slash === -1 ? ref : ref.slice(slash + 1);
}

/**
 * What this client did that the host does not know yet: a merge in flight, and a Resolve click
 * whose message has not reached the thread. Shared by the card and the composer chip.
 */
const prFlowLocalAtom = Atom.family((_threadKey: string) =>
  Atom.make<{
    /** The pull request (its thread key) being merged from this client. */
    readonly merging: string | null;
    readonly asked: { readonly number: number; readonly userMessages: number } | null;
  }>({ merging: null, asked: null }).pipe(
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
  /** The git menu is opening a pull request the thread has no link for yet. */
  readonly creating: boolean;
  readonly resolveConflicts: () => void;
  readonly merge: () => void;
  /** Where the thread's git commands run, for the composer's git chips. */
  readonly gitCwd: string | null;
}

/**
 * The thread's pull request as one flow: the git menu's progress while it opens one, then the
 * host's state, the checkout's commits and conflicts, the host's checks and what the agent is
 * running. `pullRequest` is one pull request by its thread key, or "current" for the thread's
 * current one (which also follows the git menu while it opens one). `detailed` reads the commits
 * and checks; `follow` refetches the commits as the agent's git commands finish, for the one
 * live card per thread.
 */
export function useThreadPrFlow(
  threadRef: ScopedThreadRef,
  options: {
    readonly pullRequest: "current" | string;
    readonly detailed: boolean;
    readonly follow: boolean;
  },
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
  const visible = visibleThreadPullRequests(shell?.pullRequests ?? []);
  const link =
    options.pullRequest === "current"
      ? resolveThreadCurrentPullRequestLink(visible)
      : (visible.find((candidate) => threadPullRequestKeyOf(candidate) === options.pullRequest) ??
        null);
  const linkKey = link === null ? null : threadPullRequestKeyOf(link);
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
  const resolveMergeMethod = usePullRequestMergeMethodResolver(
    environmentId,
    shell?.projectId ?? null,
  );
  const { perform } = usePullRequestActionRunner({ environmentId, reference, resolveMergeMethod });
  const [local, setLocal] = useAtom(prFlowLocalAtom(scopedThreadKey(threadRef)));
  const command = useThreadProjectionSelector(threadRef, selectRunningCommand);
  const gitCommandsKey = useThreadProjectionSelector(threadRef, selectGitCommandsKey);
  const resolvingNumber = useThreadProjectionSelector(threadRef, selectResolvingNumber);
  const userMessages = useThreadProjectionSelector(threadRef, selectUserMessages);
  // A Resolve click counts until its message reaches the thread; from then on the thread says it.
  const asked = local.asked;

  const creating =
    options.pullRequest === "current" &&
    action.isRunning &&
    (action.action === "create_pr" || action.action === "commit_push_pr");
  const detailed =
    options.detailed &&
    !creating &&
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
  // While the git menu opens the pull request, the branch against the base it will most likely
  // target. Same input as the pull request's own graph, so the card that follows reads it warm.
  const creatingBase = creating ? branchOfRef(statusQuery.data?.branchChanges?.baseRef) : null;
  const creatingHead = shell?.branch ?? null;
  const creatingGraphQuery = useEnvironmentQuery(
    creating && gitCwd !== null && creatingBase !== null && creatingHead !== null
      ? pullRequestEnvironment.graph({
          environmentId,
          input: { cwd: gitCwd, baseBranch: creatingBase, headBranch: creatingHead },
        })
      : null,
  );
  const creatingStep = creating ? (action.currentPhaseLabel ?? action.currentLabel) : null;
  const refreshCreatingGraph = creatingGraphQuery.refresh;
  const lastCreatingStep = useRef(creatingStep);
  useEffect(() => {
    if (lastCreatingStep.current === creatingStep) return;
    lastCreatingStep.current = creatingStep;
    // Each step moves the branch: the commit lands, then the push.
    if (creatingStep !== null) refreshCreatingGraph();
  }, [creatingStep, refreshCreatingGraph]);
  const nowMinute = useNowMinute();

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
        stepLabel: creatingStep,
        commitsToPush:
          status == null
            ? null
            : ((status.hasUpstream ? status.aheadCount : status.aheadOfDefaultCount) ?? null),
        graph: creatingGraphQuery.data ?? null,
        base: creatingBase,
        uncommittedFiles: status?.workingTree.files.length ?? null,
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
            merging: linkKey !== null && local.merging === linkKey,
            command,
            justOpened: Date.parse(nowMinute) - Date.parse(link.linkedAt) < JUST_OPENED_MS,
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
    if (local.merging !== null || linkKey === null) return;
    setLocal((current) => ({ ...current, merging: linkKey }));
    void perform("merge").finally(() => setLocal((current) => ({ ...current, merging: null })));
  };

  return { flow, creating, resolveConflicts, merge, gitCwd };
}
