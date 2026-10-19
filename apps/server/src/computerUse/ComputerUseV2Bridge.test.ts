import { expect, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnId,
  type OrchestrationV2DomainEvent,
  OrchestrationV2DomainEvent as DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ProviderThread,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import type * as SqlError from "effect/sql/SqlError";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as Bridge from "./ComputerUseV2Bridge.ts";
import * as ThreadState from "./ComputerUseThreadState.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as ComputerUse from "./ComputerUseService.ts";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";

const threadId = v2Projection.thread.id;
const run: OrchestrationV2Run = {
  id: RunId.make("computer-run"),
  threadId,
  ordinal: 1,
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: v2Projection.thread.modelSelection,
  providerThreadId: ProviderThreadId.make("computer-provider-thread"),
  userMessageId: MessageId.make("computer-message"),
  rootNodeId: NodeId.make("computer-root"),
  activeAttemptId: RunAttemptId.make("computer-attempt"),
  status: "running",
  requestedAt: v2Now,
  startedAt: v2Now,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
  viewcodeRuntimeMode: "full-access",
};
const providerThread: OrchestrationV2ProviderThread = {
  id: run.providerThreadId!,
  driver: ProviderDriverKind.make("codex"),
  providerInstanceId: run.providerInstanceId,
  providerSessionId: ProviderSessionId.make("computer-session"),
  appThreadId: threadId,
  ownerNodeId: null,
  nativeThreadRef: null,
  nativeConversationHeadRef: null,
  status: "active",
  firstRunOrdinal: 1,
  lastRunOrdinal: 1,
  handoffIds: [],
  forkedFrom: null,
  createdAt: v2Now,
  updatedAt: v2Now,
};
const open = (id = "computer-use:approval"): ProviderRuntimeEvent => ({
  eventId: EventId.make(`${id}:opened`),
  type: "request.opened",
  provider: providerThread.driver,
  providerInstanceId: run.providerInstanceId,
  threadId,
  turnId: TurnId.make(run.id),
  requestId: RuntimeRequestId.make(id),
  createdAt: "2026-10-18T00:00:00.000Z",
  payload: {
    requestType: "permission_approval",
    appName: "Computer use",
    detail: "Click Save?",
    options: [
      { decision: "accept", label: "Allow once" },
      { decision: "decline", label: "Decline" },
    ],
  },
});

const withBridge = <A, E>(
  test: (h: {
    readonly publish: (event: ProviderRuntimeEvent) => Effect.Effect<void>;
    readonly events: OrchestrationV2DomainEvent[];
    readonly stopRun: () => void;
    readonly restart: Bridge.ComputerUseV2Bridge["Service"]["start"];
    readonly persistPending: Effect.Effect<void, SqlError.SqlError>;
  }) => Effect.Effect<A, E, Scope.Scope>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      let publish: ((event: ProviderRuntimeEvent) => Effect.Effect<void>) | undefined;
      const events: OrchestrationV2DomainEvent[] = [];
      let currentRun = run;
      const sink = Layer.mock(EventSink.EventSinkV2)({
        latestSequence: () => Effect.succeed(0),
        stream: () => Stream.empty,
        writeIfRunCurrent: ({ events: incoming }) =>
          Effect.sync(() => {
            events.push(...incoming);
            return { committed: true, storedEvents: [] };
          }),
        write: ({ events: incoming }) =>
          Effect.sync(() => {
            events.push(...incoming);
            return [];
          }),
      });
      const projections = Layer.mock(ProjectionStore.ProjectionStoreV2)({
        getRunningTurnContext: () =>
          Effect.succeed({ run: currentRun, providerThread, providerTurn: undefined }),
        getNextTurnItemOrdinal: () => Effect.succeed(0),
        getRuntimeResponseContext: () =>
          Effect.succeed({
            request: events.findLast((event) => event.type === "runtime-request.updated")
              ?.payload as never,
            node: events.findLast((event) => event.type === "node.updated")?.payload as never,
            item: events.findLast((event) => event.type === "turn-item.updated")?.payload as never,
            session: undefined,
          }),
      });
      const computer = Layer.mock(ComputerUse.ComputerUseService)({
        attachRuntimeEventPublisher: (callback) =>
          Effect.sync(() => {
            publish = callback;
          }),
        releaseAll: Effect.void,
      });
      const layer = Bridge.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            Sqlite.layerMemory,
            sink,
            projections,
            computer,
            ThreadCommandExecutor.layer,
          ),
        ),
      );
      return yield* Effect.gen(function* () {
        const bridge = yield* Bridge.ComputerUseV2Bridge;
        yield* bridge.start();
        const sql = yield* SqlClient.SqlClient;
        const persistPending =
          sql`INSERT INTO orchestration_v2_projection_runtime_requests (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json) VALUES ('computer-use:approval', ${threadId}, 'computer-node', 'permission', 'pending', '2026-10-18T00:00:00.000Z', '{"viewcodeComputerUse":true}')`.pipe(
            Effect.asVoid,
          );
        return yield* test({
          restart: bridge.start,
          persistPending,
          publish: (event) => publish!(event),
          events,
          stopRun: () => {
            currentRun = { ...run, id: RunId.make("replacement-run") };
          },
        });
      }).pipe(Effect.provide(layer));
    }),
  );

it.effect(
  "publishes computer approval as native runtime request, node and card owned by the running session",
  () =>
    withBridge((h) =>
      Effect.gen(function* () {
        yield* h.publish(open());
        expect(h.events).toHaveLength(3);
        expect(h.events.every(Schema.is(DomainEvent))).toBe(true);
        const event = h.events.find((event) => event.type === "runtime-request.updated");
        expect(event?.payload).toMatchObject({
          viewcodeComputerUse: true,
          status: "pending",
          responseCapability: { type: "live", providerSessionId: providerThread.providerSessionId },
        });
        const node = h.events.find((event) => event.type === "node.updated");
        expect(node?.payload).toMatchObject({
          parentNodeId: run.rootNodeId,
          kind: "approval_request",
        });
        expect(node?.nodeId).not.toBe(run.rootNodeId);
        const card = h.events.find((event) => event.type === "turn-item.updated");
        expect(card?.payload).toMatchObject({
          type: "approval_request",
          prompt: "Click Save?",
          options: [{ decision: "accept" }, { decision: "decline" }],
        });
      }),
    ),
);

it.effect("refuses publishing a computer approval after the run changed", () =>
  withBridge((h) =>
    Effect.gen(function* () {
      h.stopRun();
      const result = yield* Effect.exit(h.publish(open()));
      expect(result._tag).toBe("Failure");
      expect(h.events).toEqual([]);
    }),
  ),
);

it.effect(
  "expires durable computer approvals after restart instead of reviving a lost in-memory grant",
  () =>
    withBridge((h) =>
      Effect.gen(function* () {
        yield* h.publish(open());
        yield* h.persistPending;
        yield* h.restart();
        const closed = h.events.findLast((event) => event.type === "runtime-request.updated");
        expect(closed?.payload).toMatchObject({ status: "expired", decision: "cancel" });
        expect(h.events.findLast((event) => event.type === "node.updated")?.payload).toMatchObject({
          status: "cancelled",
        });
      }),
    ),
);

it.effect(
  "requires native run/session ownership and never upgrades a running turn from a loosened setting",
  () =>
    Effect.gen(function* () {
      let currentThread = v2Projection.thread;
      let currentRun = run;
      let session = {
        id: providerThread.providerSessionId!,
        driver: providerThread.driver,
        providerInstanceId: providerThread.providerInstanceId,
        status: "running" as "running" | "stopped",
        cwd: "/sandbox",
        model: "gpt-5",
        capabilities: CodexProviderCapabilitiesV2,
        createdAt: v2Now,
        updatedAt: v2Now,
        lastError: null,
      };
      const layer = ThreadState.layer.pipe(
        Layer.provide(
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getThreadProviderContext: () =>
              Effect.sync(() => ({
                thread: currentThread,
                providerThreads: [providerThread],
                providerSessions: [session],
              })),
            getRunningTurnContext: () =>
              Effect.sync(() => ({ run: currentRun, providerThread, providerTurn: undefined })),
          }),
        ),
      );
      return yield* Effect.gen(function* () {
        const state = yield* ThreadState.ComputerUseThreadState;
        const caller = { threadId, providerInstanceId: run.providerInstanceId };
        expect((yield* state.running(caller))?.fullAccess).toBe(true);
        currentRun = { ...run, viewcodeRuntimeMode: "approval-required" };
        expect((yield* state.running(caller))?.fullAccess).toBe(false);
        currentRun = run;
        currentThread = { ...v2Projection.thread, runtimeMode: "approval-required" };
        expect((yield* state.running(caller))?.fullAccess).toBe(false);
        currentThread = v2Projection.thread;
        expect(
          yield* state.running({
            ...caller,
            providerInstanceId: ProviderInstanceId.make("another-account"),
          }),
        ).toBeUndefined();
        session = { ...session, status: "stopped" };
        expect(yield* state.running(caller)).toBeUndefined();
        session = { ...session, status: "running" };
        currentThread = { ...currentThread, archivedAt: v2Now };
        expect(yield* state.running(caller)).toBeUndefined();
      }).pipe(Effect.provide(layer));
    }),
);
