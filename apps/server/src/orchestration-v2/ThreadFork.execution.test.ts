import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as ProjectionStore from "./ProjectionStore.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import { ClaudeProviderCapabilitiesV2 } from "./Adapters/ClaudeAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const forkCases = (["codex", "claudeAgent"] as const).flatMap((driverName) => {
  const driver = ProviderDriverKind.make(driverName);
  const instanceId = ProviderInstanceId.make(driver);
  const modelSelection = { instanceId, model: "test-model" };
  const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
    instanceId,
    driver,
    getCapabilities: () =>
      Effect.succeed(
        driver === "codex" ? CodexProviderCapabilitiesV2 : ClaudeProviderCapabilitiesV2,
      ),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("Execution is paused after dispatch for handoff inspection"),
  };
  const layer = ProviderReplayHarness.layerWithRegistry(
    { name: `fork-boundary-${driver}` },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { runEffectWorker: false },
  );

  return (["failed", "interrupted", "cancelled"] as const).map((status) => ({
    driver,
    status,
    instanceId,
    modelSelection,
    layer,
  }));
});

it.effect("a persisted fork leaves PR watching with its parent until explicitly opted in", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const eventSink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const { instanceId, modelSelection } = forkCases[0]!;
    const sourceThreadId = ThreadId.make("fork-watch-source");
    const targetThreadId = ThreadId.make("fork-watch-target");
    const sourceRunId = RunId.make("fork-watch-source-run");
    const key = { host: "github.com", repository: "example/repo", number: 1 };
    const link = { url: "https://github.com/example/repo/pull/1", source: "agent" as const };

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("fork-watch-create"),
      threadId: sourceThreadId,
      projectId: ProjectId.make("fork-watch-project"),
      title: "Watching source",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
    yield* eventSink.write({
      events: [
        {
          id: EventId.make("fork-watch-source-run"),
          type: "run.created",
          threadId: sourceThreadId,
          runId: sourceRunId,
          occurredAt: now,
          payload: {
            id: sourceRunId,
            threadId: sourceThreadId,
            ordinal: 1,
            providerInstanceId: instanceId,
            modelSelection,
            providerThreadId: null,
            userMessageId: MessageId.make("fork-watch-source-message"),
            rootNodeId: null,
            activeAttemptId: null,
            status: "completed",
            requestedAt: now,
            startedAt: now,
            completedAt: now,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-parent-start"),
      threadId: sourceThreadId,
      ...key,
      watching: true,
      link,
    });
    const parentBefore = yield* orchestrator.getThreadShell(sourceThreadId);
    const parentWatch = parentBefore?.pullRequests?.[0]?.watch;
    assert.isDefined(parentWatch);
    assert.lengthOf(parentBefore?.pendingBackgroundTasks ?? [], 1);

    yield* orchestrator.dispatch({
      type: "thread.fork",
      commandId: CommandId.make("fork-watch-fork"),
      sourceThreadId,
      targetThreadId,
      sourcePoint: { type: "run", runId: sourceRunId },
      createdBy: "user",
      creationSource: "mcp",
    });
    const fork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isNotNull(fork);
    assert.deepEqual(fork.pullRequests, [
      {
        ...key,
        ...link,
        linkedAt: parentWatch.startedAt,
        snapshot: null,
        stack: null,
      },
    ]);
    assert.deepEqual(fork.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    // A delayed watcher update cannot reinstate the parent's subscription on the fork.
    const stale = yield* orchestrator
      .dispatch({
        type: "thread.pull-request-watch.sync",
        commandId: CommandId.make("fork-watch-stale-sync"),
        threadId: targetThreadId,
        ...key,
        startedAt: parentWatch.startedAt,
        watch: parentWatch,
        wake: {
          messageId: MessageId.make("fork-watch-unwanted-wake"),
          text: "A check failed",
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: "A check failed",
          },
        },
      })
      .pipe(Effect.flip);
    assert.equal(stale._tag, "OrchestratorDispatchError");
    assert.deepEqual((yield* orchestrator.getThreadProjection(targetThreadId)).runs, []);

    // Advance virtual time only to distinguish the independent watch's start time.
    yield* TestClock.adjust("1 second");
    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-in"),
      threadId: targetThreadId,
      ...key,
      watching: true,
      link,
    });
    const watchingFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.isDefined(watchingFork?.pullRequests?.[0]?.watch);
    assert.notEqual(watchingFork.pullRequests[0].watch.startedAt, parentWatch.startedAt);
    assert.lengthOf(watchingFork.pendingBackgroundTasks ?? [], 1);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);

    yield* orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make("fork-watch-opt-out"),
      threadId: targetThreadId,
      ...key,
      watching: false,
    });
    const stoppedFork = yield* orchestrator.getThreadShell(targetThreadId);
    assert.deepEqual(stoppedFork?.pullRequests, [
      { ...fork.pullRequests![0]!, endedWatch: watchingFork.pullRequests[0].watch },
    ]);
    assert.deepEqual(stoppedFork?.pendingBackgroundTasks, []);
    assert.deepEqual(yield* orchestrator.getThreadShell(sourceThreadId), parentBefore);
  }).pipe(Effect.provide(forkCases[0]!.layer)),
);

it.effect.each(forkCases)(
  "bounds $driver context when continuing a fork of a $status run",
  ({ driver, status, instanceId, modelSelection, layer }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const sourceThreadId = ThreadId.make("fork-boundary-source");
      const targetThreadId = ThreadId.make("fork-boundary-target");
      const providerThreadId = ProviderThreadId.make("fork-boundary-native-thread");
      const sourceRunId = RunId.make("fork-boundary-source-run");
      const attemptId = RunAttemptId.make("interrupted-source-attempt");
      const providerTurnId = ProviderTurnId.make("interrupted-source-turn");
      const rootNodeId = NodeId.make("interrupted-source-root");

      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-source"),
        threadId: sourceThreadId,
        projectId: ProjectId.make("fork-boundary-project"),
        title: "Fork boundary source",
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("source-provider-thread"),
            type: "provider-thread.updated",
            threadId: sourceThreadId,
            occurredAt: now,
            payload: {
              id: providerThreadId,
              driver,
              providerInstanceId: instanceId,
              providerSessionId: null,
              appThreadId: sourceThreadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: "native-source", strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: 1,
              lastRunOrdinal: 2,
              handoffIds: [],
              forkedFrom: null,
              createdAt: now,
              updatedAt: now,
            },
          },
        ],
      });
      if (status === "interrupted") {
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("source-attempt"),
              type: "run-attempt.created",
              threadId: sourceThreadId,
              runId: sourceRunId,
              occurredAt: now,
              payload: {
                id: attemptId,
                runId: sourceRunId,
                attemptOrdinal: 1,
                rootNodeId,
                providerInstanceId: instanceId,
                providerThreadId,
                providerTurnId,
                reason: "initial",
                status,
                startedAt: now,
                completedAt: now,
              },
            },
            {
              id: EventId.make("source-provider-turn"),
              type: "provider-turn.updated",
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                id: providerTurnId,
                providerThreadId,
                nodeId: rootNodeId,
                runAttemptId: attemptId,
                nativeTurnRef: { driver, nativeId: "turn:synthetic", strength: "weak" },
                ordinal: 1,
                status,
                startedAt: now,
                completedAt: now,
              },
            },
          ],
        });
      }
      for (const ordinal of [1, 2]) {
        const runId = ordinal === 1 ? sourceRunId : RunId.make("later-run");
        const messageId = MessageId.make(`source-message-${ordinal}`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`run-${ordinal}`),
              type: "run.created",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId: sourceThreadId,
                ordinal,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: messageId,
                rootNodeId: null,
                activeAttemptId: ordinal === 1 && status === "interrupted" ? attemptId : null,
                status: ordinal === 1 ? status : "completed",
                queuePosition: null,
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              id: EventId.make(`item-${ordinal}`),
              type: "turn-item.updated",
              threadId: sourceThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make(`item-${ordinal}`),
                threadId: sourceThreadId,
                runId,
                nodeId: null,
                providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                status: "completed",
                title: null,
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                type: "user_message",
                createdBy: "user",
                creationSource: "web",
                inputIntent: "turn_start",
                messageId,
                text: ordinal === 1 ? "INCLUDED_SOURCE_MARKER" : "EXCLUDED_LATER_MARKER",
                attachments: [],
              },
            },
          ],
        });
      }
      yield* orchestrator.dispatch({
        type: "thread.fork",
        kind: "sidechat",
        commandId: CommandId.make("fork-source"),
        sourceThreadId,
        targetThreadId,
        sourcePoint: { type: "run", runId: sourceRunId },
        createdBy: "user",
        creationSource: "web",
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("continue-fork"),
        threadId: targetThreadId,
        messageId: MessageId.make("continue-fork"),
        text: "Continue from the selected source run",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
        createdBy: "user",
        creationSource: "web",
      });
      const target = yield* orchestrator.getThreadProjection(targetThreadId);
      assert.equal(target.thread.kind, "sidechat");
      assert.equal(target.thread.parentThreadId, sourceThreadId);
      assert.equal(target.thread.lineage.parentThreadId, sourceThreadId);
      assert.equal(target.contextTransfers[0]?.resolution?.strategy, "portable_context");
      assert.lengthOf(target.contextHandoffs, 1);
      const handoff = target.contextHandoffs[0]!;
      const history = handoff.history?.messages.map((message) => message.text).join("\n") ?? "";
      assert.include(`${handoff.summaryText}\n${history}`, "INCLUDED_SOURCE_MARKER");
      assert.notInclude(`${handoff.summaryText}\n${history}`, "EXCLUDED_LATER_MARKER");
      assert.isNull(target.providerThreads[0]?.forkedFrom);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "bootstraps a first-turn side chat from bounded parent messages while ordinary forks still require a stable run",
  () =>
    Effect.gen(function* () {
      const { layer, instanceId, modelSelection } = forkCases[0]!;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const sourceThreadId = ThreadId.make("sidechat-bootstrap-parent");
        const targetThreadId = ThreadId.make("sidechat-bootstrap-child");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("sidechat-parent:create"),
          threadId: sourceThreadId,
          projectId: ProjectId.make("sidechat-project"),
          title: "Parent",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        for (const [ordinal, role] of (["user", "assistant"] as const).entries()) {
          yield* eventSink.write({
            events: [
              {
                type: "turn-item.updated",
                id: EventId.make(`sidechat:parent:${role}`),
                threadId: sourceThreadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`sidechat:item:${role}`),
                  threadId: sourceThreadId,
                  runId: null,
                  nodeId: null,
                  providerThreadId: null,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal: ordinal + 1,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  ...(role === "user"
                    ? {
                        type: "user_message" as const,
                        createdBy: "user" as const,
                        creationSource: "web" as const,
                        inputIntent: "turn_start" as const,
                        messageId: MessageId.make("source-user"),
                        text: "PARENT_CONTEXT_MARKER",
                        attachments: [],
                      }
                    : {
                        type: "assistant_message" as const,
                        text: "Parent is still working",
                        messageId: MessageId.make("source-assistant"),
                        streaming: false,
                      }),
                },
              },
            ],
          });
        }
        const rejected = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("ordinary-unstable-fork"),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.equal(rejected._tag, "OrchestratorDispatchError");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          kind: "sidechat",
          commandId: CommandId.make("sidechat-fork"),
          sourceThreadId,
          targetThreadId,
          sourcePoint: { type: "latest_stable" },
          createdBy: "user",
          creationSource: "web",
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("sidechat-question"),
          threadId: targetThreadId,
          messageId: MessageId.make("sidechat-question"),
          text: "What does that mean?",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          modelSelection,
          createdBy: "user",
          creationSource: "web",
        });
        const target = yield* orchestrator.getThreadProjection(targetThreadId);
        assert.equal(target.thread.kind, "sidechat");
        assert.equal(target.thread.lineage.parentThreadId, sourceThreadId);
        assert.isNull(target.thread.forkedFrom);
        assert.lengthOf(target.contextHandoffs, 1);
        assert.include(target.contextHandoffs[0]!.summaryText, "Parent conversation snapshot");
        assert.include(
          target.contextHandoffs[0]!.history!.messages.map((message) => message.text).join("\n"),
          "PARENT_CONTEXT_MARKER",
        );
        assert.lengthOf(
          target.turnItems.filter((item) => item.type === "user_message"),
          1,
        );
        assert.equal(target.thread.providerInstanceId, instanceId);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect.each([
  { driver: "codex", imported: false },
  { driver: "claudeAgent", imported: false },
  { driver: "codex", imported: true },
  { driver: "claudeAgent", imported: true },
])(
  "copies an exact immutable $driver user prefix (imported=$imported) into full, paged and portable history",
  ({ driver, imported }) =>
    Effect.gen(function* () {
      const testCase = forkCases.find((entry) => entry.driver === driver)!;
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const store = orchestrator;
        const now = yield* DateTime.now;
        const sourceThreadId = ThreadId.make("exact-source");
        const targetThreadId = ThreadId.make("exact-target");
        const runId = RunId.make("exact-run");
        const sourceProviderThreadId = ProviderThreadId.make("exact-native");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("exact-create"),
          threadId: sourceThreadId,
          projectId: ProjectId.make("exact-project"),
          title: "Source",
          modelSelection: testCase.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const sourceThread = (yield* store.getThreadProjection(sourceThreadId)).thread;
        if (imported)
          yield* eventSink.write({
            events: [
              {
                type: "thread.created",
                id: EventId.make("exact-imported"),
                threadId: sourceThreadId,
                occurredAt: now,
                payload: { ...sourceThread, historyOrigin: "v1_import" },
              },
            ],
          });
        if (!imported)
          yield* eventSink.write({
            events: [
              {
                type: "provider-thread.updated",
                id: EventId.make("exact-provider"),
                threadId: sourceThreadId,
                occurredAt: now,
                payload: {
                  id: sourceProviderThreadId,
                  driver: testCase.driver,
                  providerInstanceId: testCase.instanceId,
                  providerSessionId: null,
                  appThreadId: sourceThreadId,
                  ownerNodeId: null,
                  nativeThreadRef: {
                    driver: testCase.driver,
                    nativeId: "strong-exact-source",
                    strength: "strong",
                  },
                  nativeConversationHeadRef: null,
                  status: "not_loaded",
                  firstRunOrdinal: 1,
                  lastRunOrdinal: 1,
                  handoffIds: [],
                  forkedFrom: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                type: "run.created",
                id: EventId.make("exact-run-created"),
                threadId: sourceThreadId,
                runId,
                occurredAt: now,
                payload: {
                  id: runId,
                  threadId: sourceThreadId,
                  ordinal: 1,
                  providerInstanceId: testCase.instanceId,
                  modelSelection: testCase.modelSelection,
                  providerThreadId: sourceProviderThreadId,
                  userMessageId: MessageId.make("selected-user"),
                  rootNodeId: null,
                  activeAttemptId: null,
                  status: "completed",
                  queuePosition: null,
                  requestedAt: now,
                  startedAt: now,
                  completedAt: now,
                  checkpointId: null,
                  contextHandoffId: null,
                },
              },
            ],
          });
        // More than 100 copied rows exercise ordering against the first new run's native ordinal.
        for (let ordinal = 1; ordinal <= 124; ordinal++) {
          const isUser = ordinal % 2 === 1;
          const selected = ordinal === 121;
          yield* eventSink.write({
            events: [
              {
                type: "turn-item.updated",
                id: EventId.make(`exact-item-${ordinal}`),
                threadId: sourceThreadId,
                occurredAt: now,
                payload: {
                  id: TurnItemId.make(`exact-item-${ordinal}`),
                  threadId: sourceThreadId,
                  runId: imported ? null : runId,
                  nodeId: null,
                  providerThreadId: imported ? null : sourceProviderThreadId,
                  providerTurnId: null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal,
                  status: "completed",
                  title: null,
                  startedAt: now,
                  completedAt: now,
                  updatedAt: now,
                  ...(isUser
                    ? {
                        type: "user_message" as const,
                        messageId: MessageId.make(
                          selected ? "selected-user" : `exact-message-${ordinal}`,
                        ),
                        createdBy: "user" as const,
                        creationSource: "web" as const,
                        inputIntent: "turn_start" as const,
                        text: selected
                          ? "SELECTED_USER"
                          : ordinal > 121
                            ? "FORBIDDEN_LATER_USER"
                            : `prefix-${ordinal}`,
                        attachments: [],
                      }
                    : {
                        type: "assistant_message" as const,
                        messageId: MessageId.make(`exact-message-${ordinal}`),
                        text: ordinal > 121 ? "FORBIDDEN_ASSISTANT_REPLY" : `prefix-${ordinal}`,
                        streaming: false,
                      }),
                },
              },
            ],
          });
        }
        const fork = (id: string, messageId: string) =>
          orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make(id),
            sourceThreadId,
            targetThreadId,
            sourcePoint: { type: "latest_stable" },
            sourceMessageId: MessageId.make(messageId),
            createdBy: "user",
            creationSource: "web",
          });
        for (const [id, messageId] of [
          ["missing", "missing"],
          ["assistant", "exact-message-122"],
        ]) {
          const error = yield* fork(id!, messageId!).pipe(Effect.flip);
          assert.equal(error._tag, "OrchestratorDispatchError");
          assert.isNull(yield* store.getThreadShell(targetThreadId));
        }
        if (!imported) {
          const originalRun = (yield* store.getThreadProjection(sourceThreadId)).runs[0]!;
          for (const status of ["running", "queued", "rolled_back"] as const) {
            yield* eventSink.write({
              events: [
                {
                  type: "run.updated",
                  id: EventId.make(`exact-unsafe-${status}`),
                  threadId: sourceThreadId,
                  runId,
                  occurredAt: now,
                  payload: { ...originalRun, status },
                },
              ],
            });
            const error = yield* fork(`unsafe-${status}`, "selected-user").pipe(Effect.flip);
            assert.equal(error._tag, "OrchestratorDispatchError");
            assert.isNull(yield* store.getThreadShell(targetThreadId));
          }
          yield* eventSink.write({
            events: [
              {
                type: "run.updated",
                id: EventId.make("exact-stable-again"),
                threadId: sourceThreadId,
                runId,
                occurredAt: now,
                payload: originalRun,
              },
            ],
          });
        }
        const foreignThreadId = ThreadId.make("exact-other-project");
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("exact-create-other-project"),
          threadId: foreignThreadId,
          projectId: ProjectId.make("foreign-project"),
          title: "Other project",
          modelSelection: testCase.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdBy: "user",
          creationSource: "web",
        });
        const crossProject = yield* orchestrator
          .dispatch({
            type: "thread.fork",
            commandId: CommandId.make("exact-cross-project"),
            sourceThreadId,
            targetThreadId: foreignThreadId,
            sourcePoint: { type: "latest_stable" },
            sourceMessageId: MessageId.make("selected-user"),
            createdBy: "user",
            creationSource: "web",
          })
          .pipe(Effect.flip);
        assert.equal(crossProject._tag, "OrchestratorDispatchError");
        assert.equal(
          (yield* store.getThreadProjection(foreignThreadId)).thread.projectId,
          "foreign-project",
        );
        // A deleted target is still owned data, even though it is absent from the shell.
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("foreign-retained-message"),
              type: "message.updated",
              threadId: foreignThreadId,
              occurredAt: now,
              payload: {
                id: MessageId.make("foreign-retained-message"),
                threadId: foreignThreadId,
                role: "user",
                text: "RETAINED_OTHER_PROJECT_DATA",
                attachments: [],
                runId: null,
                nodeId: null,
                createdBy: "user",
                creationSource: "web",
                createdAt: now,
                updatedAt: now,
                streaming: false,
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("delete-owned-target"),
          threadId: foreignThreadId,
        });
        const tombstoneBefore = yield* store.getThreadProjection(foreignThreadId);
        assert.isNotNull(tombstoneBefore.thread.deletedAt);
        assert.isNull(yield* store.getThreadShell(foreignThreadId));
        const deletedTargetResult = yield* Effect.exit(
          orchestrator.dispatch({
            type: "thread.fork",
            commandId: CommandId.make("exact-deleted-target"),
            sourceThreadId,
            targetThreadId: foreignThreadId,
            sourcePoint: { type: "latest_stable" },
            sourceMessageId: MessageId.make("selected-user"),
            createdBy: "user",
            creationSource: "web",
          }),
        );
        assert.equal(deletedTargetResult._tag, "Failure");
        assert.deepEqual(yield* store.getThreadProjection(foreignThreadId), tombstoneBefore);

        yield* fork("exact-fork", "selected-user");
        const target = yield* store.getThreadProjection(targetThreadId);
        assert.equal(
          target.thread.historyOrigin,
          imported ? "v1_import" : sourceThread.historyOrigin,
        );
        assert.equal(target.thread.viewcodeMessageFork?.messageId, "selected-user");
        assert.isNull(target.thread.forkedFrom);
        assert.lengthOf(target.messages, 121);
        assert.lengthOf(target.visibleTurnItems, 121);
        assert.equal(target.contextTransfers[0]?.sourcePoint.messageId, "selected-user");
        assert.equal(target.contextTransfers[0]?.sourcePoint.turnItemId, "exact-item-121");
        assert.notInclude(JSON.stringify(target), "FORBIDDEN_");
        const replayStore = yield* Effect.gen(function* () {
          return yield* ProjectionStore.ProjectionStoreV2;
        }).pipe(Effect.provide(ProjectionStore.layerMemory));
        yield* eventSink
          .readByCommandId({ commandId: CommandId.make("exact-fork") })
          .pipe(Stream.runForEach((stored) => replayStore.apply(stored.event)));
        const replayed = yield* replayStore.getThreadProjection(targetThreadId);
        assert.deepEqual(replayed.thread, target.thread);
        assert.deepEqual(replayed.visibleTurnItems, target.visibleTurnItems);
        assert.deepEqual(replayed.contextTransfers, target.contextTransfers);
        const historyPage = yield* store.getThreadHistoryPage(
          targetThreadId,
          encodeThreadHistoryCursor({
            snapshotSequence: 0,
            sourceThreadId: targetThreadId,
            sourceItemId: target.turnItems[100]!.id,
            position: 100,
          }),
        );
        assert.isNotEmpty(historyPage.items);
        assert.notInclude(JSON.stringify(historyPage), "FORBIDDEN_");
        const page = yield* store.getTimelinePage(targetThreadId, {
          view: "messages",
          limit: 20,
          afterPosition: 100,
        });
        assert.equal(page.totalItems, 121);
        assert.equal(page.items.at(-1)?.item.type, "user_message");
        assert.notInclude(JSON.stringify(page), "FORBIDDEN_");
        const bounded = yield* store.getThreadSnapshotWindow(targetThreadId, { rowLimit: 20 });
        assert.equal(
          bounded.projection.visibleTurnItems.at(-1)?.item.id,
          target.visibleTurnItems.at(-1)?.item.id,
        );
        assert.notInclude(JSON.stringify(bounded), "FORBIDDEN_");
        const older = yield* store.getThreadSnapshotWindow(targetThreadId, {
          rowLimit: 20,
          anchorItemId: target.turnItems[50]!.id,
        });
        assert.equal(older.projection.visibleTurnItems.at(-1)?.item.id, target.turnItems[50]!.id);
        // Source edits after fork creation cannot change its visible or portable prefix.
        const selectedSource = (yield* store.getThreadProjection(sourceThreadId)).turnItems.find(
          (item) => item.id === "exact-item-121",
        )!;
        yield* eventSink.write({
          events: [
            {
              type: "turn-item.updated",
              id: EventId.make("exact-source-edited"),
              threadId: sourceThreadId,
              occurredAt: now,
              payload: {
                ...selectedSource,
                ...(selectedSource.type === "user_message"
                  ? { text: "FORBIDDEN_SOURCE_EDIT" }
                  : {}),
              },
            },
          ],
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("exact-continue"),
          threadId: targetThreadId,
          messageId: MessageId.make("exact-followup"),
          text: "Continue the selected user request",
          attachments: [],
          modelSelection: testCase.modelSelection,
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        });
        const continued = yield* store.getThreadProjection(targetThreadId);
        assert.equal(continued.contextTransfers[0]?.resolution?.strategy, "portable_context");
        assert.isNull(continued.providerThreads[0]?.forkedFrom);
        assert.lengthOf(continued.contextHandoffs, 1);
        const context = JSON.stringify(continued.contextHandoffs);
        assert.include(context, "SELECTED_USER");
        assert.notInclude(context, "FORBIDDEN_");
        assert.equal(continued.visibleTurnItems.at(-1)?.item.type, "user_message");
        assert.equal(continued.messages.at(-1)?.id, "exact-followup");
        // An ordinary run fork of the snapshot keeps its prefix in inherited paging,
        // and an exact fork can select that inherited runless user message again.
        const completed = { ...continued.runs[0]!, status: "completed" as const, completedAt: now };
        yield* eventSink.write({
          events: [
            {
              type: "run.updated",
              id: EventId.make("exact-finish"),
              threadId: targetThreadId,
              runId: completed.id,
              occurredAt: now,
              payload: completed,
            },
          ],
        });
        const nestedThreadId = ThreadId.make("exact-nested-native-fork");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("exact-nested-native"),
          sourceThreadId: targetThreadId,
          targetThreadId: nestedThreadId,
          sourcePoint: { type: "run", runId: completed.id },
          createdBy: "user",
          creationSource: "web",
        });
        const nested = yield* store.getThreadProjection(nestedThreadId);
        assert.isUndefined(nested.thread.viewcodeMessageFork);
        assert.include(JSON.stringify(nested.visibleTurnItems), "SELECTED_USER");
        assert.notInclude(JSON.stringify(nested.visibleTurnItems), "FORBIDDEN_");
        const nestedShell = yield* store.getThreadShell(nestedThreadId);
        assert.equal(nestedShell?.visibleItemCount, nested.visibleTurnItems.length);
        const nestedPage = yield* store.getThreadSnapshotWindow(nestedThreadId, { rowLimit: 150 });
        assert.include(JSON.stringify(nestedPage.projection.visibleTurnItems), "SELECTED_USER");
        assert.notInclude(JSON.stringify(nestedPage), "FORBIDDEN_");
        const exactAgainThreadId = ThreadId.make("exact-again");
        yield* orchestrator.dispatch({
          type: "thread.fork",
          commandId: CommandId.make("exact-again-create"),
          sourceThreadId: nestedThreadId,
          targetThreadId: exactAgainThreadId,
          sourcePoint: { type: "latest_stable" },
          sourceMessageId: MessageId.make(`fork:${targetThreadId}:selected-user`),
          createdBy: "user",
          creationSource: "web",
        });
        const exactAgain = yield* store.getThreadProjection(exactAgainThreadId);
        assert.lengthOf(exactAgain.messages, 121);
        assert.notInclude(JSON.stringify(exactAgain), "exact-followup");
        assert.notInclude(JSON.stringify(exactAgain), "FORBIDDEN_");
      }).pipe(Effect.provide(testCase.layer));
    }),
);
