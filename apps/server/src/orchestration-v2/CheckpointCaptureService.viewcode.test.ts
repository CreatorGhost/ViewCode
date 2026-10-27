import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type SpeakMode,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ViewCodeSpokenSummary from "./ViewCodeSpokenSummary.ts";

// ViewCode speak mode: completing a turn enqueues one spoken summary, which the
// effect worker stores on the turn's final assistant message.

const threadId = ThreadId.make("thread:spoken-summary");
const projectId = ProjectId.make("project:spoken-summary");
const runId = RunId.make("run:spoken-summary");
const scopeId = CheckpointScopeId.make("scope:spoken-summary");
const rootNodeId = NodeId.make("node:spoken-summary-root");
const providerThreadId = ProviderThreadId.make("provider-thread:spoken-summary");
const assistantMessageId = MessageId.make("message:spoken-summary-assistant");
const providerInstanceId = ProviderInstanceId.make("claude");
const driver = ProviderDriverKind.make("claudeAgent");
const modelSelection = { instanceId: providerInstanceId, model: "claude-opus-5-5" } as const;
const summaryCommandId = CommandId.make(`command:effect:spoken-summary.generate:${runId}`);

const seedWaitingTurn = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const base = { threadId, occurredAt: now } as const;
  yield* projections.apply({
    ...base,
    id: EventId.make("event:spoken-summary:thread"),
    type: "thread.created",
    payload: {
      createdBy: "user",
      creationSource: "web",
      id: threadId,
      projectId,
      title: "Spoken summary",
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
  yield* projections.apply({
    ...base,
    id: EventId.make("event:spoken-summary:run"),
    type: "run.updated",
    runId,
    nodeId: rootNodeId,
    providerInstanceId,
    payload: {
      id: runId,
      threadId,
      ordinal: 1,
      providerInstanceId,
      modelSelection,
      providerThreadId,
      userMessageId: MessageId.make("message:spoken-summary-user"),
      rootNodeId,
      activeAttemptId: null,
      status: "waiting",
      requestedAt: now,
      startedAt: now,
      completedAt: null,
      checkpointId: null,
      contextHandoffId: null,
    },
  });
  yield* projections.apply({
    ...base,
    id: EventId.make("event:spoken-summary:node"),
    type: "node.updated",
    runId,
    nodeId: rootNodeId,
    providerInstanceId,
    payload: {
      id: rootNodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId,
      kind: "root_turn",
      status: "waiting",
      countsForRun: true,
      providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: scopeId,
      startedAt: now,
      completedAt: null,
    },
  });
  yield* projections.apply({
    ...base,
    id: EventId.make("event:spoken-summary:provider-thread"),
    type: "provider-thread.updated",
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    payload: {
      id: providerThreadId,
      driver,
      providerInstanceId,
      providerSessionId: null,
      appThreadId: threadId,
      ownerNodeId: rootNodeId,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: "idle",
      firstRunOrdinal: 1,
      lastRunOrdinal: 1,
      handoffIds: [],
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* projections.apply({
    ...base,
    id: EventId.make("event:spoken-summary:scope"),
    type: "checkpoint-scope.created",
    runId,
    nodeId: rootNodeId,
    payload: {
      id: scopeId,
      threadId,
      runId,
      nodeId: rootNodeId,
      parentScopeId: null,
      providerThreadId,
      kind: "root_run",
      ordinalWithinParent: 0,
      advancesAppRunCount: true,
      cwd: "/repo",
      createdAt: now,
    },
  });
  yield* projections.apply({
    ...base,
    id: EventId.make("event:spoken-summary:baseline"),
    type: "checkpoint.captured",
    nodeId: rootNodeId,
    driver,
    providerInstanceId,
    payload: {
      id: CheckpointId.make("checkpoint:spoken-summary-0"),
      threadId,
      scopeId,
      runId: null,
      nodeId: rootNodeId,
      parentCheckpointId: null,
      ordinalWithinScope: 0,
      appRunOrdinal: null,
      ref: CheckpointRef.make("checkpoint-ref:spoken-summary-0"),
      status: "ready",
      files: [],
      capturedAt: now,
    },
  });
  const replies = [
    ["message:spoken-summary-progress", "Looking at the failing test first."],
    [assistantMessageId, "## Done\n\nFixed the flaky `retry` test and ran the suite."],
  ] as const;
  for (const [index, [id, text]] of replies.entries()) {
    const at = DateTime.add(now, { seconds: index + 1 });
    yield* projections.apply({
      ...base,
      id: EventId.make(`event:${id}`),
      type: "message.updated",
      runId,
      nodeId: rootNodeId,
      payload: {
        createdBy: "agent",
        creationSource: "provider",
        id: MessageId.make(id),
        threadId,
        runId,
        nodeId: rootNodeId,
        role: "assistant",
        text,
        attachments: [],
        streaming: false,
        createdAt: at,
        updatedAt: at,
      },
    });
  }
});

interface Scenario {
  readonly speakMode: SpeakMode;
  readonly generate: (calls: number) => Effect.Effect<string, TextGenerationError>;
}

const runScenario = (scenario: Scenario) =>
  Effect.gen(function* () {
    const requests = yield* Ref.make<ReadonlyArray<ModelSelection>>([]);
    const layerDatabase = SqlitePersistence.layerMemory;
    const layerStores = Layer.mergeAll(
      layerDatabase,
      EventStore.layer.pipe(Layer.provideMerge(layerDatabase)),
      ProjectionStore.layer.pipe(Layer.provideMerge(layerDatabase)),
    );
    const layerEventSink = EventSink.layer.pipe(Layer.provide(layerStores));
    const layerSettings = ServerSettings.layerTest({ speakMode: scenario.speakMode });
    const layerSpokenSummary = ViewCodeSpokenSummary.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerStores,
          layerEventSink,
          layerSettings,
          IdAllocator.layer,
          Layer.mock(ProjectStore.ProjectStoreV2)({
            get: () => Effect.succeedSome({ workspaceRoot: "/repo" } as never),
          }),
          Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
            getInstance: () => Effect.succeed({ driverKind: driver } as never),
          }),
          Layer.mock(TextGeneration.TextGeneration)({
            generateSpokenSummary: (input) =>
              Ref.updateAndGet(requests, (all) => [...all, input.modelSelection]).pipe(
                Effect.flatMap((all) => scenario.generate(all.length)),
                Effect.map((summary) => ({ summary })),
              ),
          }),
        ),
      ),
    );
    const layerExecutor = Layer.effect(
      EffectWorker.OrchestrationEffectExecutorV2,
      Effect.gen(function* () {
        const spokenSummaries = yield* ViewCodeSpokenSummary.ViewCodeSpokenSummaryService;
        return EffectWorker.OrchestrationEffectExecutorV2.of({
          execute: (effect) =>
            effect.request.type === "spoken-summary.generate"
              ? spokenSummaries.execute({ threadId: effect.threadId, runId: effect.request.runId })
              : Effect.die(`unexpected effect ${effect.request.type}`),
        });
      }),
    ).pipe(Layer.provide(layerSpokenSummary));
    const layerCapture = CheckpointCaptureService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          layerStores,
          layerEventSink,
          layerSettings,
          IdAllocator.layer,
          Layer.mock(CheckpointService.CheckpointServiceV2)({
            capture: (input) =>
              Effect.succeed({
                id: CheckpointId.make("checkpoint:spoken-summary-1"),
                threadId,
                scopeId,
                runId,
                nodeId: input.nodeId,
                parentCheckpointId: CheckpointId.make("checkpoint:spoken-summary-0"),
                ordinalWithinScope: 1,
                appRunOrdinal: 1,
                ref: CheckpointRef.make("checkpoint-ref:spoken-summary-1"),
                status: "ready" as const,
                files: [],
                capturedAt: input.capturedAt,
              }),
          }),
        ),
      ),
    );
    const layer = Layer.mergeAll(
      layerStores,
      layerCapture,
      layerSpokenSummary,
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      EffectWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(EffectOutbox.layer.pipe(Layer.provide(layerDatabase)), layerExecutor),
        ),
      ),
    );

    return yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const capture = yield* CheckpointCaptureService.CheckpointCaptureServiceV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const spokenSummaries = yield* ViewCodeSpokenSummary.ViewCodeSpokenSummaryService;
      yield* seedWaitingTurn;

      // A capture retried after it committed, and a summary effect delivered
      // twice, must still produce one generation.
      yield* capture.execute({ threadId, runId, scopeId });
      yield* worker.drain();
      yield* capture.execute({ threadId, runId, scopeId });
      yield* worker.drain();
      yield* spokenSummaries.execute({ threadId, runId });

      const { runs, messages } = yield* projections.getThreadRecords(threadId, [
        "runs",
        "messages",
      ]);
      return {
        run: runs.find((run) => run.id === runId),
        messages,
        requests: yield* Ref.get(requests),
        summaryEffects: yield* outbox.listByCommandId(summaryCommandId),
      };
    }).pipe(Effect.provide(layer));
  });

it.effect(
  "speak mode summary stores one summary on the turn's final reply, from the cheap model of the turn's provider",
  () =>
    Effect.gen(function* () {
      const result = yield* runScenario({
        speakMode: "summary",
        generate: () => Effect.succeed("Fixed the flaky retry test. The whole suite passes."),
      });

      assert.equal(result.run?.status, "completed");
      assert.deepEqual(result.requests, [
        { instanceId: providerInstanceId, model: "claude-haiku-5-5" },
      ]);
      assert.deepEqual(
        result.messages.map((message) => [message.id, message.spokenSummary]),
        [
          [MessageId.make("message:spoken-summary-progress"), undefined],
          [assistantMessageId, "Fixed the flaky retry test. The whole suite passes."],
        ],
      );
      assert.deepEqual(
        result.summaryEffects.map((effect) => effect.status),
        ["succeeded"],
      );
    }),
);

it.effect.each(["off", "full"] as const)("speak mode %s generates no summary", (speakMode) =>
  Effect.gen(function* () {
    const result = yield* runScenario({
      speakMode,
      generate: () => Effect.die("speak mode is not summary"),
    });

    assert.equal(result.run?.status, "completed");
    assert.deepEqual(result.summaryEffects, []);
    assert.isTrue(result.messages.every((message) => message.spokenSummary === undefined));
  }),
);

it.effect("a failed generation leaves the completed turn intact and without a summary", () =>
  Effect.gen(function* () {
    const result = yield* runScenario({
      speakMode: "summary",
      generate: () =>
        Effect.fail(
          new TextGenerationError({ operation: "generateSpokenSummary", detail: "out of quota" }),
        ),
    });

    assert.equal(result.run?.status, "completed");
    assert.equal(
      result.messages.find((message) => message.id === assistantMessageId)?.text,
      "## Done\n\nFixed the flaky `retry` test and ran the suite.",
    );
    assert.isTrue(result.messages.every((message) => message.spokenSummary === undefined));
    assert.deepEqual(
      result.summaryEffects.map((effect) => effect.status),
      ["succeeded"],
    );
  }),
);
