import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { createPendingAttachmentId, resolveAttachmentPath } from "../attachmentStore.ts";
import { ChatAttachmentId } from "@t3tools/contracts";
import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as EventStore from "./EventStore.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadLaunch from "./ThreadLaunchService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadMessageIntake from "./ThreadMessageIntake.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = { instanceId, model: "controlled-queue-model" };
const threadId = ThreadId.make("shared-queue-thread");

const makeControlledProvider = Effect.gen(function* () {
  const inputs = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2TurnInput>();
  const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  const deliveries = yield* Ref.make<ReadonlyArray<MessageId>>([]);
  const turnFor = (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      return {
        id: ProviderTurnId.make(`native-turn:${input.runId}`),
        providerThreadId: input.providerThread.id,
        nodeId: input.rootNodeId,
        runAttemptId: input.attemptId,
        nativeTurnRef: { driver, nativeId: input.runId, strength: "strong" },
        ordinal: PositiveInt.make(input.providerTurnOrdinal),
        status: "running" as const,
        startedAt: now,
        completedAt: null,
      } satisfies OrchestrationV2ProviderTurn;
    });
  const adapter = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: (input) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: input.providerSessionId,
          providerSession: {
            id: input.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd: input.runtimePolicy.cwd ?? process.cwd(),
            model: input.modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: (request) =>
            Effect.succeed({
              id: ProviderThreadId.make(`native:${request.threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: request.threadId,
              ownerNodeId: null,
              nativeThreadRef: { driver, nativeId: request.threadId, strength: "strong" },
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              pendingBackgroundTasks: [],
              contextUsage: null,
              nativeMetadata: null,
              goal: null,
              createdAt: now,
              updatedAt: now,
            }),
          resumeThread: (request) => Effect.succeed(request.providerThread),
          startTurn: (request) =>
            Effect.gen(function* () {
              yield* Ref.update(deliveries, (current) => [...current, request.message.messageId]);
              yield* Queue.offer(events, {
                type: "provider_turn.updated",
                driver,
                providerTurn: yield* turnFor(request),
              });
              yield* Queue.offer(inputs, request);
            }),
          steerTurn: () => Effect.die("Queue tests must not steer"),
          interruptTurn: () => Effect.void,
          readThreadSnapshot: () => Effect.die("Queue tests must not read provider history"),
          rollbackThread: () => Effect.die("Queue tests must not roll back"),
          forkThread: () => Effect.die("Queue tests must not fork"),
          respondToRuntimeRequest: () => Effect.die("Queue tests must not answer requests"),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  } satisfies ProviderAdapter.ProviderAdapterV2["Service"];
  return {
    adapter,
    inputs,
    deliveries,
    complete: (input: ProviderAdapter.ProviderAdapterV2TurnInput) =>
      Effect.gen(function* () {
        const turn = yield* turnFor(input);
        const now = yield* DateTime.now;
        yield* Queue.offer(events, {
          type: "provider_turn.updated",
          driver,
          providerTurn: { ...turn, status: "completed", completedAt: now },
        });
        yield* Queue.offer(events, {
          type: "turn.terminal",
          driver,
          providerThreadId: input.providerThread.id,
          providerTurnId: turn.id,
          runOrdinal: PositiveInt.make(input.runOrdinal),
          status: "completed",
          failure: null,
          threadDisposition: "reusable",
        });
      }),
  };
});

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-shared-queue-" });
  const workspace = yield* checkpointWorkspace("viewcode-shared-queue");
  const dbPath = path.join(directory, "statev2.sqlite");
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const config = ServerConfig.layerTest(workspace, { prefix: "viewcode-queue-intake-" }).pipe(
    Layer.provide(NodeServices.layer),
  );
  const settings = ServerSettings.layerTest({
    providerInstances: { [instanceId]: { driver, enabled: true, config: {} } },
  });
  const makeRuntime = (
    provider: Effect.Success<typeof makeControlledProvider>,
    recover = false,
  ) => {
    const native = ProviderReplayHarness.layerWithRegistry(
      { name: "viewcode-shared-queue" },
      ProviderAdapterRegistry.layerFromAdapters([provider.adapter]),
      { databaseLayer: database, recoverOnStartup: recover, serverConfigLayer: config },
    );
    return Layer.mergeAll(
      ThreadManagement.layer,
      ProjectionMaintenance.layer.pipe(
        Layer.provide(EventStore.layer),
        Layer.provide(ProjectionStore.layer),
        Layer.provide(database),
      ),
    ).pipe(
      Layer.provideMerge(native),
      Layer.provideMerge(CommandReceiptStore.layer.pipe(Layer.provide(database))),
      Layer.provideMerge(settings),
      Layer.provideMerge(config),
      Layer.provideMerge(Layer.mock(ThreadLaunch.ThreadLaunchService)({})),
      Layer.provide(NodeServices.layer),
    );
  };
  return { workspace, dbPath, makeRuntime };
});

const dispatch = ThreadMessageIntake.dispatchCommand;
const createThread = (workspace: string) =>
  dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-shared-queue"),
    threadId,
    projectId: ProjectId.make("shared-queue-project"),
    title: "Shared queue",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: workspace,
    createdBy: "user",
    creationSource: "web",
  });
const message = (
  id: string,
  text = id,
): Extract<OrchestrationV2Command, { type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(`dispatch:${id}`),
  threadId,
  messageId: MessageId.make(id),
  text,
  attachments: [],
  modelSelection,
  dispatchMode: { type: "queue_after_active" },
  createdBy: "user",
  creationSource: "web",
});
const projection = Orchestrator.OrchestratorV2.use((orchestrator) =>
  orchestrator.getThreadProjection(threadId),
);
const runFor = (messageId: string) =>
  projection.pipe(
    Effect.map((current) => {
      const run = current.runs.find((entry) => entry.userMessageId === messageId);
      assert.isDefined(run);
      return run;
    }),
  );
const awaitStatus = (run: OrchestrationV2Run, status: OrchestrationV2Run["status"]) =>
  Orchestrator.OrchestratorV2.use((orchestrator) =>
    orchestrator.streamStoredEventsFrom({ threadId }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "run.updated" &&
          stored.event.payload.id === run.id &&
          stored.event.payload.status === status,
      ),
      Stream.take(1),
      Stream.runDrain,
    ),
  );
const assertReceipt = (commandId: CommandId, sequence: number) =>
  CommandReceiptStore.CommandReceiptStoreV2.use((receipts) =>
    receipts.getByCommandId(commandId),
  ).pipe(
    Effect.map((receipt) => {
      assert.isTrue(Option.isSome(receipt));
      if (Option.isSome(receipt)) {
        assert.equal(receipt.value.status, "accepted");
        assert.equal(receipt.value.resultSequence, sequence);
      }
    }),
  );

it.effect(
  "delivers edited and reordered accepted messages headlessly and never delivers cancelled work",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const provider = yield* makeControlledProvider;
      yield* Effect.gen(function* () {
        yield* createThread(fixture.workspace);
        yield* dispatch(message("active"));
        const active = yield* Queue.take(provider.inputs);
        for (const id of ["first", "second", "cancelled"]) {
          const command = message(id);
          const accepted = yield* dispatch(command);
          yield* assertReceipt(command.commandId, accepted.sequence);
        }
        const first = yield* runFor("first");
        const second = yield* runFor("second");
        const cancelled = yield* runFor("cancelled");
        const mutations: OrchestrationV2Command[] = [
          {
            type: "queued-run.edit",
            commandId: CommandId.make("edit-second"),
            threadId,
            runId: second.id,
            text: "Second edited on another client",
          },
          {
            type: "queued-run.reorder",
            commandId: CommandId.make("move-second"),
            threadId,
            runId: second.id,
            beforeRunId: first.id,
          },
          {
            type: "queued-run.cancel",
            commandId: CommandId.make("cancel-third"),
            threadId,
            runId: cancelled.id,
          },
        ];
        for (const command of mutations) {
          const accepted = yield* dispatch(command);
          yield* assertReceipt(command.commandId, accepted.sequence);
          const readThroughReceipt = Orchestrator.OrchestratorV2.use((orchestrator) =>
            orchestrator.streamStoredEventsFrom({ threadId }).pipe(
              Stream.takeUntil((stored) => stored.sequence >= accepted.sequence),
              Stream.runCollect,
            ),
          );
          const [clientA, clientB] = yield* Effect.all([readThroughReceipt, readThroughReceipt]);
          assert.deepEqual(clientA, clientB);
          assert.equal(clientA.at(-1)?.sequence, accepted.sequence);
        }
        // No client-side sender or subscription exists during terminal promotion.
        yield* provider.complete(active);
        const next = yield* Queue.take(provider.inputs);
        assert.equal(next.message.messageId, second.userMessageId);
        assert.equal(next.message.text, "Second edited on another client");
        yield* provider.complete(next);
        const last = yield* Queue.take(provider.inputs);
        assert.equal(last.message.messageId, first.userMessageId);
        yield* provider.complete(last);
        yield* awaitStatus(first, "completed");
        yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
        assert.deepEqual(yield* Ref.get(provider.deliveries), [
          MessageId.make("active"),
          second.userMessageId,
          first.userMessageId,
        ]);
        assert.equal((yield* runFor("cancelled")).status, "cancelled");
      }).pipe(Effect.provide(fixture.makeRuntime(provider)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "replays accepted admission after a lost acknowledgement without duplicating delivery",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const provider = yield* makeControlledProvider;
      yield* Effect.gen(function* () {
        yield* createThread(fixture.workspace);
        yield* dispatch(message("active"));
        const active = yield* Queue.take(provider.inputs);
        const command = message("replayed", "Accepted exactly once");
        const original = yield* dispatch(command);
        // The caller discards its acknowledgement and retries the original stable ids.
        const retried = yield* dispatch(command);
        assert.equal(retried.sequence, original.sequence);
        yield* assertReceipt(command.commandId, original.sequence);
        assert.equal(
          (yield* projection).runs.filter((run) => run.userMessageId === command.messageId).length,
          1,
        );
        yield* provider.complete(active);
        const next = yield* Queue.take(provider.inputs);
        assert.equal(next.message.messageId, command.messageId);
        assert.equal(next.message.text, command.text);
        yield* dispatch(command);
        yield* provider.complete(next);
        yield* awaitStatus(yield* runFor("replayed"), "completed");
        yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
        assert.deepEqual(yield* Ref.get(provider.deliveries), [
          MessageId.make("active"),
          command.messageId,
        ]);
      }).pipe(Effect.provide(fixture.makeRuntime(provider)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["queued-run.edit", "queued-run.cancel"] as const)(
  "rejects %s when native delivery has already won",
  (type) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const provider = yield* makeControlledProvider;
      yield* Effect.gen(function* () {
        yield* createThread(fixture.workspace);
        yield* dispatch(message("active"));
        const active = yield* Queue.take(provider.inputs);
        yield* dispatch(message("next", "Accepted content"));
        const queued = yield* runFor("next");
        yield* provider.complete(active);
        const delivered = yield* Queue.take(provider.inputs);
        assert.equal(delivered.runId, queued.id);
        const target = { commandId: CommandId.make(`late:${type}`), threadId, runId: queued.id };
        const rejected = yield* dispatch(
          type === "queued-run.edit" ? { ...target, type, text: "Too late" } : { ...target, type },
        ).pipe(Effect.result);
        assert.equal(rejected._tag, "Failure");
        if (rejected._tag === "Failure") {
          assert.equal(
            rejected.failure._tag,
            type === "queued-run.edit"
              ? "OrchestratorCommandRejectedError"
              : "OrchestratorDispatchError",
          );
        }
        const current = yield* projection;
        assert.equal(
          current.messages.find((entry) => entry.id === queued.userMessageId)?.text,
          "Accepted content",
        );
        assert.notEqual(current.runs.find((entry) => entry.id === queued.id)?.status, "cancelled");
        assert.equal(delivered.message.text, "Accepted content");
        yield* provider.complete(delivered);
        yield* awaitStatus(queued, "completed");
        yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
        assert.deepEqual(yield* Ref.get(provider.deliveries), [
          MessageId.make("active"),
          MessageId.make("next"),
        ]);
      }).pipe(Effect.provide(fixture.makeRuntime(provider)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "reopens durable held work in a new runtime and starts it only after explicit resume",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const beforeRestart = yield* makeControlledProvider;
      const queuedBefore = yield* Effect.gen(function* () {
        yield* createThread(fixture.workspace);
        yield* dispatch(message("active"));
        yield* Queue.take(beforeRestart.inputs);
        yield* dispatch(message("first", "First durable message"));
        yield* dispatch(message("second", "Second durable message"));
        const first = yield* runFor("first");
        const second = yield* runFor("second");
        yield* dispatch({
          type: "queued-run.edit",
          commandId: CommandId.make("durable-edit"),
          threadId,
          runId: second.id,
          text: "Edited before restart",
        });
        yield* dispatch({
          type: "queued-run.reorder",
          commandId: CommandId.make("durable-order"),
          threadId,
          runId: second.id,
          beforeRunId: first.id,
        });
        return { first, second, messages: (yield* projection).messages };
      }).pipe(Effect.provide(fixture.makeRuntime(beforeRestart)));

      const afterRestart = yield* makeControlledProvider;
      yield* Effect.gen(function* () {
        assert.isTrue(
          yield* ProjectionMaintenance.ProjectionMaintenanceV2.use(
            (maintenance) => maintenance.rebuild,
          ).pipe(Effect.map((verification) => verification.valid)),
        );
        const reopened = yield* projection;
        assert.deepEqual(reopened.messages, queuedBefore.messages);
        for (const expected of [queuedBefore.first, queuedBefore.second]) {
          const actual = reopened.runs.find((run) => run.id === expected.id);
          assert.equal(actual?.status, "queued");
          assert.isTrue(actual?.queueHeld);
          assert.equal(actual?.userMessageId, expected.userMessageId);
        }
        assert.equal(
          yield* Orchestrator.OrchestratorV2.use((orchestrator) => orchestrator.resumeQueuedRuns),
          0,
        );
        yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
        assert.deepEqual(yield* Ref.get(afterRestart.deliveries), []);
        const resume: OrchestrationV2Command = {
          type: "queue.resume",
          commandId: CommandId.make("resume-durable"),
          threadId,
        };
        const accepted = yield* dispatch(resume);
        const replay = yield* dispatch(resume);
        assert.equal(accepted.sequence, replay.sequence);
        yield* assertReceipt(resume.commandId, accepted.sequence);
        const first = yield* Queue.take(afterRestart.inputs);
        assert.equal(first.runId, queuedBefore.second.id);
        assert.equal(first.message.text, "Edited before restart");
        yield* afterRestart.complete(first);
        const second = yield* Queue.take(afterRestart.inputs);
        assert.equal(second.runId, queuedBefore.first.id);
        assert.equal(second.message.text, "First durable message");
        yield* afterRestart.complete(second);
        yield* awaitStatus(queuedBefore.first, "completed");
        yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
        assert.deepEqual(yield* Ref.get(afterRestart.deliveries), [
          queuedBefore.second.userMessageId,
          queuedBefore.first.userMessageId,
        ]);
        assert.equal((yield* projection).runs.length, 3);
      }).pipe(Effect.provide(fixture.makeRuntime(afterRestart, true)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "retains accepted uploaded bytes and attachment identity across client-independent delivery",
  () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const provider = yield* makeControlledProvider;
      yield* Effect.gen(function* () {
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        yield* createThread(fixture.workspace);
        yield* dispatch(message("active"));
        const active = yield* Queue.take(provider.inputs);
        const id = ChatAttachmentId.make(createPendingAttachmentId()!);
        const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
        const pendingPath = path.join(config.attachmentsDir, `${id}.png`);
        yield* fs.writeFile(pendingPath, bytes);
        const accepted = yield* dispatch({
          ...message("uploaded"),
          attachments: [
            {
              id,
              type: "image",
              name: "capture.png",
              mimeType: "image/png",
              sizeBytes: bytes.length,
            },
          ],
        });
        yield* assertReceipt(CommandId.make("dispatch:uploaded"), accepted.sequence);
        const before = yield* projection;
        const attachment = before.messages.find((entry) => entry.id === "uploaded")?.attachments[0];
        assert.isDefined(attachment);
        assert.notEqual(attachment.id, id);
        // Claims copy uploads so a lost acknowledgement can retry. Delivery owns
        // its claimed copy even after the original upload is removed.
        assert.isTrue(yield* fs.exists(pendingPath));
        yield* fs.remove(pendingPath);
        const storedPath = resolveAttachmentPath({
          attachmentsDir: config.attachmentsDir,
          attachment,
        });
        assert.isNotNull(storedPath);
        assert.deepEqual(yield* fs.readFile(storedPath), bytes);
        const edit = {
          type: "queued-run.edit" as const,
          commandId: CommandId.make("attachment-text-edit"),
          threadId,
          runId: (yield* runFor("uploaded")).id,
          text: "Text edit keeps uploaded bytes",
        };
        yield* dispatch(edit);
        yield* provider.complete(active);
        const delivered = yield* Queue.take(provider.inputs);
        assert.deepEqual(delivered.message.attachments, [attachment]);
        assert.equal(delivered.message.text, edit.text);
        assert.deepEqual(yield* fs.readFile(storedPath), bytes);
        yield* provider.complete(delivered);
        yield* awaitStatus(yield* runFor("uploaded"), "completed");
      }).pipe(Effect.provide(fixture.makeRuntime(provider)));
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each(["machine", "project"] as const)(
  "refuses new shared-queue admission when the provider is disabled by %s settings",
  (scope) =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture;
      const provider = yield* makeControlledProvider;
      yield* Effect.gen(function* () {
        yield* createThread(fixture.workspace);
        yield* dispatch(message("active"));
        const active = yield* Queue.take(provider.inputs);
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* settings.updateSettings(
          scope === "machine"
            ? {
                providerInstances: { [instanceId]: { driver, enabled: false, config: {} } },
              }
            : {
                projectSettingsOverrides: {
                  [ProjectId.make("shared-queue-project")]: {
                    providerInstances: { [instanceId]: { enabled: false } },
                  },
                },
              },
        );
        const command = message("blocked");
        const result = yield* dispatch(command).pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.equal(result.failure._tag, "ThreadManagementProviderInstanceDisabledError");
        assert.isFalse(
          (yield* projection).messages.some((entry) => entry.id === command.messageId),
        );
        yield* provider.complete(active);
        yield* awaitStatus(yield* runFor("active"), "completed");
        yield* EffectWorker.OrchestrationEffectWorkerV2.use((worker) => worker.drain());
        assert.deepEqual(yield* Ref.get(provider.deliveries), [MessageId.make("active")]);
      }).pipe(Effect.provide(fixture.makeRuntime(provider)));
    }).pipe(Effect.provide(NodeServices.layer)),
);
