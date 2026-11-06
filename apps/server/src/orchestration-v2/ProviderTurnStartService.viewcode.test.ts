import { expect, vi } from "vite-plus/test";
import { it as effectIt } from "@effect/vitest";
import {
  CheckpointScopeId,
  ContextHandoffId,
  ContextTransferId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ContextHandoff,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderAuthService from "../provider/ProviderAuthService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ContextHandoffService from "./ContextHandoffService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderSessionManager from "./ProviderSessionManager.ts";
import * as ProviderTurnStart from "./ProviderTurnStartService.ts";
import * as RunExecutionService from "./RunExecutionService.ts";
import * as RuntimePolicy from "./RuntimePolicy.ts";

const now = DateTime.makeUnsafe("2026-11-07T12:00:00Z");
const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex-personal");
const threadId = ThreadId.make("thread-fork-target");
const sourceThreadId = ThreadId.make("thread-fork-source");
const sourceRunId = RunId.make("run-fork-source");
const runId = RunId.make("run-fork-target");
const rootNodeId = NodeId.make("root-fork-target");
const attemptId = RunAttemptId.make("attempt-fork-target");
const providerThreadId = ProviderThreadId.make("provider-thread-fork-target");
const sourceProviderThreadId = ProviderThreadId.make("provider-thread-fork-source");
const providerSessionId = ProviderSessionId.make("provider-session-fork");
const transferId = ContextTransferId.make("transfer-fork");
const messageId = MessageId.make("message-fork-target");
const checkpointScopeId = CheckpointScopeId.make("scope-fork-target");

function makeForkHarness() {
  const run: OrchestrationV2ThreadProjection["runs"][number] = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-5.4" },
    providerThreadId,
    userMessageId: messageId,
    rootNodeId,
    activeAttemptId: attemptId,
    status: "starting",
    requestedAt: now,
    startedAt: null,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  const providerThread: OrchestrationV2ThreadProjection["providerThreads"][number] = {
    id: providerThreadId,
    driver,
    providerInstanceId: instanceId,
    providerSessionId,
    appThreadId: threadId,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "not_loaded",
    firstRunOrdinal: 1,
    lastRunOrdinal: 1,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
  };
  const sourceProviderThread = {
    ...providerThread,
    id: sourceProviderThreadId,
    appThreadId: sourceThreadId,
    nativeThreadRef: { driver, nativeId: "source-native-session", strength: "strong" as const },
  };
  // One projection serves both threads: the fork reads the source run and its
  // provider thread from it, and the target run from it.
  let projection: OrchestrationV2ThreadProjection = {
    thread: {
      id: threadId,
      activeProviderThreadId: providerThreadId,
      projectId: ProjectId.make("project-fork"),
      branch: null,
      worktreePath: null,
    } as OrchestrationV2ThreadProjection["thread"],
    runs: [
      {
        ...run,
        id: sourceRunId,
        threadId: sourceThreadId,
        providerThreadId: sourceProviderThreadId,
        status: "completed",
      },
      run,
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        rootNodeId,
        attemptOrdinal: 1,
        providerInstanceId: instanceId,
        providerThreadId,
        providerTurnId: null,
        reason: "initial",
        status: "pending",
        startedAt: null,
        completedAt: null,
      },
    ],
    nodes: [
      {
        id: rootNodeId,
        threadId,
        runId,
        parentNodeId: null,
        rootNodeId,
        kind: "root_turn",
        status: "pending",
        countsForRun: true,
        providerThreadId,
        providerTurnId: null,
        nativeItemRef: null,
        runtimeRequestId: null,
        checkpointScopeId,
        startedAt: null,
        completedAt: null,
      },
    ],
    providerThreads: [sourceProviderThread, providerThread],
    messages: [
      {
        id: messageId,
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "user",
        text: "Write it all up in one file",
        attachments: [],
        streaming: false,
        createdBy: "user",
        creationSource: "web",
        createdAt: now,
        updatedAt: now,
      },
    ],
    checkpointScopes: [
      {
        id: checkpointScopeId,
        threadId,
        runId,
        nodeId: rootNodeId,
        parentScopeId: null,
        providerThreadId,
        kind: "root_run",
        ordinalWithinParent: 0,
        advancesAppRunCount: true,
        cwd: "/tmp/fork-target",
        createdAt: now,
      },
    ],
    providerSessions: [],
    providerTurns: [],
    contextHandoffs: [],
    contextTransfers: [
      {
        id: transferId,
        type: "fork",
        sourceThreadId,
        targetThreadId: threadId,
        sourcePoint: { threadId: sourceThreadId, runId: sourceRunId },
        basePoint: null,
        sourceProviderInstanceId: instanceId,
        targetProviderInstanceId: instanceId,
        targetRunId: runId,
        status: "pending",
        resolution: null,
        createdBy: "user",
        error: null,
        createdAt: now,
        updatedAt: now,
        consumedAt: null,
      },
    ],
    turnItems: [],
    visibleTurnItems: [],
    runtimeRequests: [],
    subagents: [],
    plans: [],
    checkpoints: [],
    updatedAt: now,
  };

  const events: Array<OrchestrationV2DomainEvent> = [];
  const forkThread = vi.fn(() =>
    Effect.fail(
      new ProviderAdapter.ProviderAdapterForkThreadError({
        driver,
        providerThreadId: sourceProviderThreadId,
        cause: "Session source-native-session not found in project directory",
      }),
    ),
  );
  const freshNativeThread = {
    ...providerThread,
    nativeThreadRef: { driver, nativeId: "fresh-native-session", strength: "strong" as const },
  };
  const ensureThread = vi.fn(() => Effect.succeed(freshNativeThread));
  const handoff = {
    id: ContextHandoffId.make("handoff-fork-fallback"),
    transferId,
    threadId,
    targetRunId: runId,
    fromProviderThreadIds: [sourceProviderThreadId],
    toProviderThreadId: providerThreadId,
    coveredRunOrdinals: { from: 1, to: 1 },
    strategy: "full_thread_summary",
    status: "ready",
    summaryMessageId: null,
    summaryText: "Earlier: the source conversation.",
    createdByProviderInstanceId: null,
    createdAt: now,
    updatedAt: now,
  } as OrchestrationV2ContextHandoff;
  const prepareProviderHandoff = vi.fn(() => Effect.succeed(handoff));
  const session = {
    driver,
    providerSession: {
      id: providerSessionId,
      driver,
      providerInstanceId: instanceId,
      status: "ready",
      cwd: "/tmp/fork-target",
      model: null,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    forkThread,
    ensureThread,
  };
  const startRootRun = vi.fn(() => Effect.void);
  const writeIfRunCurrent = vi.fn(({ events: incoming }) =>
    Effect.sync(() => {
      for (const event of incoming) {
        events.push(event);
        projection = ProjectionStore.applyToProjection(projection, event);
      }
      return { committed: true, storedEvents: [] };
    }),
  );
  const write = vi.fn(({ events: incoming }) =>
    Effect.sync(() => {
      for (const event of incoming) {
        events.push(event);
        projection = ProjectionStore.applyToProjection(projection, event);
      }
      return { storedEvents: [] };
    }),
  );
  const withConversation = () => ({ ...projection, hasConversation: true });

  const layer = ProviderTurnStart.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ContextHandoffService.ContextHandoffServiceV2)({ prepareProviderHandoff }),
        Layer.mock(EventSink.EventSinkV2)({ write, writeIfRunCurrent } as never),
        IdAllocator.layer,
        Path.layer,
        Layer.mock(ServerConfig.ServerConfig)({
          worktreesDir: "/tmp/fork-worktrees",
        } as ServerConfig.ServerConfig["Service"]),
        ServerSettings.layerTest(),
        FileSystem.layerNoop({ exists: () => Effect.succeed(true) }),
        Layer.mock(GitWorkflow.GitWorkflowService)({
          pruneWorktrees: () => Effect.void,
          createWorktree: () => Effect.succeed({} as never),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeed(Option.some({ workspaceRoot: "/tmp/fork" } as never)),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getThreadRecords: () => Effect.succeed(projection),
          getTurnStartContext: () => Effect.succeed(withConversation()),
          getRuntimeRecoveryProjection: () => Effect.succeed(withConversation()),
          getTurnStartHistory: () => Effect.succeed([]),
        }),
        Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({
          open: () => Effect.succeed(session as never),
        }),
        Layer.mock(ProviderAuthService.ProviderAuthService)({
          tryHandlePromptCommand: () => Effect.succeed(false),
        }),
        Layer.mock(RunExecutionService.RunExecutionServiceV2)({ startRootRun }),
        Layer.mock(RuntimePolicy.RuntimePolicyV2)({
          resolve: () => Effect.succeed({ cwd: "/tmp/fork-target" } as never),
        }),
      ),
    ),
  );

  return {
    events,
    forkThread,
    ensureThread,
    prepareProviderHandoff,
    startRootRun,
    projection: () => projection,
    start: Effect.gen(function* () {
      yield* (yield* ProviderTurnStart.ProviderTurnStartServiceV2).start({ threadId, runId });
    }).pipe(Effect.provide(layer)),
  };
}

// ViewCode guard: a native fork that cannot work (a Claude transcript over
// 2 GiB) used to fail every turn of the fork. It must fall back to portable
// context from the source thread instead.
effectIt.effect("starts a fork from portable context when the native fork fails (ViewCode)", () =>
  Effect.gen(function* () {
    const harness = makeForkHarness();

    yield* harness.start;

    expect(harness.forkThread).toHaveBeenCalledOnce();
    expect(harness.ensureThread).toHaveBeenCalledWith(
      expect.objectContaining({
        existingProviderThread: expect.objectContaining({ nativeThreadRef: null }),
      }),
    );
    expect(harness.prepareProviderHandoff).toHaveBeenCalledWith(
      expect.objectContaining({
        transferId,
        fromProviderThreadIds: [sourceProviderThreadId],
        strategy: "full_thread_summary",
      }),
    );
    const transfer = harness.projection().contextTransfers.find((t) => t.id === transferId);
    expect(transfer?.status).toBe("resolved_portable");
    expect(transfer?.resolution).toEqual({
      strategy: "portable_context",
      contextHandoffId: "handoff-fork-fallback",
    });
    expect(harness.startRootRun).toHaveBeenCalledOnce();
  }),
);
