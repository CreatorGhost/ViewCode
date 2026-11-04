import { useAtom, useAtomValue } from "@effect/atom-react";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  type PrFlow,
  type PrFlowFoldChoice,
  type PrFlowTimelinePullRequest,
  prFlowFromPullRequest,
  prFlowGitCommandsKey,
  prFlowResolvePrompt,
  prFlowResolvingNumber,
  prFlowRunningCommand,
  prFlowTimelinePullRequests,
} from "@t3tools/client-runtime/pr-flow";
import { resolvePullRequestDetailMergeMethod } from "@t3tools/client-runtime/pull-request-merge-method";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThread } from "@t3tools/client-runtime/viewcodeThread";
import { CommandId, MessageId, type ScopedThreadRef } from "@t3tools/contracts";
import { projectScriptCwd } from "@t3tools/shared/projectScripts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import { AsyncResult, Atom } from "effect/reactivity";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "react-native";

import { makeQueuedMessageMetadata } from "../../lib/commandMetadata";
import { appAtomRegistry } from "../../state/atom-registry";
import { useEnvironmentServerConfig, useProject, useThreadShell } from "../../state/entities";
import { mobilePreferencesAtom } from "../../state/preferences";
import { composerPullRequests } from "../../state/pull-requests";
import { useEnvironmentQuery } from "../../state/query";
import { enqueueThreadOutboxMessage } from "../../state/thread-outbox";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/** While the checkout is mid-merge, how often its unresolved files are read again (as on web). */
const MERGE_POLL_MS = 10_000;

const NO_PULL_REQUESTS = { pullRequests: [], currentKey: null } as const;

/**
 * The thread's pull requests for the feed. Selected as one string so the shell's other updates
 * (titles, activity, snapshots) do not re-render the conversation.
 */
export function useThreadFeedPullRequests(ref: ScopedThreadRef): {
  readonly pullRequests: ReadonlyArray<PrFlowTimelinePullRequest>;
  readonly currentKey: string | null;
} {
  const signature = useAtomValue(environmentThreadShells.threadShellAtom(ref), (shell) =>
    shell === null || shell.pullRequests.length === 0
      ? ""
      : JSON.stringify(prFlowTimelinePullRequests(shell.pullRequests)),
  );
  return useMemo(
    () =>
      signature === ""
        ? NO_PULL_REQUESTS
        : (JSON.parse(signature) as ReturnType<typeof prFlowTimelinePullRequests>),
    [signature],
  );
}

/**
 * A card's fold, chosen by the reader, for this app session (mobile keeps its folder and card
 * state per session, not on disk). Keyed by thread and pull request.
 */
const foldChoicesAtom = Atom.make<ReadonlyMap<string, PrFlowFoldChoice>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-pr-card:fold-choices"),
);

export function usePullRequestFoldChoice(ref: ScopedThreadRef, pullRequestKey: string) {
  const key = `${scopedThreadKey(ref)}\0${pullRequestKey}`;
  const choice = useAtomValue(foldChoicesAtom, (choices) => choices.get(key) ?? null);
  const setChoice = useCallback(
    (next: PrFlowFoldChoice) => {
      const current = appAtomRegistry.get(foldChoicesAtom);
      appAtomRegistry.set(foldChoicesAtom, new Map(current).set(key, next));
    },
    [key],
  );
  return [choice, setChoice] as const;
}

/**
 * What this phone did that the host does not know yet: a merge in flight, and a Resolve tap whose
 * message has not reached the thread. Web keeps the same pair per thread.
 */
const prFlowLocalAtom = Atom.family((_threadKey: string) =>
  Atom.make<{
    readonly merging: string | null;
    readonly asked: { readonly number: number; readonly userMessages: number } | null;
  }>({ merging: null, asked: null }).pipe(
    Atom.setIdleTTL(5 * 60_000),
    Atom.withLabel("mobile-pr-card:local"),
  ),
);

/** How long after the thread got a pull request an unknown mergeability reads as "checking". */
const JUST_OPENED_MS = 2 * 60_000;

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

/** Whether `linkedAt` is under `JUST_OPENED_MS` old, turning false when the window ends. */
function useJustOpened(linkedAt: string | null) {
  const [now, setNow] = useState(Date.now);
  const linkedMs = linkedAt === null ? Number.NaN : Date.parse(linkedAt);
  const remaining = linkedMs + JUST_OPENED_MS - now;
  useEffect(() => {
    if (!(remaining > 0)) return;
    const timer = setTimeout(() => setNow(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [remaining]);
  return remaining > 0;
}

/**
 * One of the thread's pull requests as web's PR card reads it: the host's state from the link
 * snapshot, the host's checks, the checkout's conflicts (`git.pullRequestGraph`, null on a server
 * without it) and what the agent is running. Mounted only for an unfolded card. `live` is the
 * thread's current pull request, which refetches as the agent's git commands finish.
 */
export function useThreadPullRequestFlow(
  ref: ScopedThreadRef,
  pullRequestKey: string,
  live: boolean,
) {
  const { environmentId } = ref;
  const shell = useThreadShell(ref);
  const project = useProject(
    shell === null ? null : scopeProjectRef(environmentId, shell.projectId),
  );
  const serverConfig = useEnvironmentServerConfig(environmentId);
  const preferences = useAtomValue(mobilePreferencesAtom);
  const gitCwd =
    project === null
      ? null
      : projectScriptCwd({
          project: { cwd: project.workspaceRoot },
          worktreePath: shell?.worktreePath ?? null,
        });
  const link =
    visibleThreadPullRequests(shell?.pullRequests ?? []).find(
      (candidate) => threadPullRequestKeyOf(candidate) === pullRequestKey,
    ) ?? null;
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
  const detailed = snapshot !== null && snapshot.state === "open" && reference !== null;
  const graphQuery = useEnvironmentQuery(
    detailed && gitCwd !== null
      ? composerPullRequests.graph({
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
    detailed ? composerPullRequests.checks({ environmentId, input: reference }) : null,
  );

  const threadAtom = environmentThreadDetails.threadAtom(ref);
  const command = useAtomValue(threadAtom, selectRunningCommand);
  const gitCommandsKey = useAtomValue(threadAtom, selectGitCommandsKey);
  const resolvingNumber = useAtomValue(threadAtom, selectResolvingNumber);
  const userMessages = useAtomValue(threadAtom, selectUserMessages);
  const [local, setLocal] = useAtom(prFlowLocalAtom(scopedThreadKey(ref)));

  // A git command the agent finished can have moved the branch, the base or the merge state.
  const refreshGraph = graphQuery.refresh;
  const lastGitCommandsKey = useRef(gitCommandsKey);
  useEffect(() => {
    if (lastGitCommandsKey.current === gitCommandsKey) return;
    lastGitCommandsKey.current = gitCommandsKey;
    if (live) refreshGraph();
  }, [gitCommandsKey, live, refreshGraph]);
  const mergeInProgress = graphQuery.data?.resolving != null;
  useEffect(() => {
    if (!live || !mergeInProgress) return;
    const timer = setInterval(refreshGraph, MERGE_POLL_MS);
    return () => clearInterval(timer);
  }, [live, mergeInProgress, refreshGraph]);

  const asked = local.asked;
  const justOpened = useJustOpened(link?.linkedAt ?? null);
  const flow: PrFlow | null =
    link === null || snapshot === null
      ? null
      : prFlowFromPullRequest(
          { number: link.number, url: link.url, ...snapshot },
          {
            graph: graphQuery.data ?? null,
            checks: checksQuery.data?.checks ?? null,
            resolveAsked:
              resolvingNumber === link.number ||
              (asked?.number === link.number && asked.userMessages === userMessages),
            merging: local.merging === pullRequestKey,
            command,
            // As on web: "Checking it merges cleanly" only while the pull request is new.
            justOpened,
          },
        );

  const runAction = useAtomCommand(composerPullRequests.runAction, { reportFailure: false });
  const projectMergeMethod =
    serverConfig === null || shell === null
      ? undefined
      : resolveProjectSettings(serverConfig.settings, shell.projectId, project).settings
          .pullRequestMergeMethod;
  const chosenMergeMethod = AsyncResult.isSuccess(preferences)
    ? preferences.value.pullRequestMergeMethod
    : undefined;

  const merge = () => {
    if (local.merging !== null || reference === null) return;
    setLocal((current) => ({ ...current, merging: pullRequestKey }));
    void runAction({
      environmentId,
      input: {
        ...reference,
        action: "merge",
        // The project's default, then the method last chosen on this phone, then squash (the
        // pull request screen's default), each only if the repository allows it.
        resolveMergeMethod: (detail) =>
          resolvePullRequestDetailMergeMethod(detail, [
            projectMergeMethod,
            chosenMergeMethod,
            "squash",
          ]),
      },
    })
      .then((result) => {
        if (result._tag === "Success") return;
        const cause = squashAtomCommandFailure(result);
        Alert.alert(
          "Couldn't merge this pull request",
          cause instanceof Error ? cause.message : "Try again.",
        );
      })
      .finally(() => setLocal((current) => ({ ...current, merging: null })));
  };

  const resolveConflicts = () => {
    if (link === null || snapshot === null) return;
    setLocal((current) => ({ ...current, asked: { number: link.number, userMessages } }));
    const metadata = makeQueuedMessageMetadata();
    // Into the chat as the reader's own message, through the outbox like Fix with agent: now, or
    // when the chat can take it if it is working.
    enqueueThreadOutboxMessage({
      environmentId,
      threadId: ref.threadId,
      messageId: MessageId.make(metadata.messageId),
      commandId: CommandId.make(metadata.commandId),
      text: prFlowResolvePrompt({
        number: link.number,
        base: snapshot.baseBranch,
        head: snapshot.headBranch,
      }),
      attachments: [],
      createdAt: metadata.createdAt,
    }).catch((error: unknown) => {
      setLocal((current) => ({ ...current, asked: null }));
      Alert.alert(
        "Couldn't ask the agent",
        error instanceof Error ? error.message : "The message could not be queued.",
      );
    });
  };

  return { flow, merge, resolveConflicts };
}
