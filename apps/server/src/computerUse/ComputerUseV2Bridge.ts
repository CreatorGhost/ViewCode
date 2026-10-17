import {
  EventId,
  NodeId,
  RuntimeRequestId,
  TurnId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type ProviderRuntimeEvent,
  ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import { forkParked } from "../serverActivation.ts";
import * as ComputerUse from "./ComputerUseService.ts";

export class ComputerUseBridgeError extends Schema.TaggedError<ComputerUseBridgeError>()(
  "ComputerUseBridgeError",
  { cause: Schema.Defect() },
) {}
export class ComputerUseV2Bridge extends Context.Service<
  ComputerUseV2Bridge,
  {
    readonly start: () => Effect.Effect<void, ComputerUseBridgeError, Scope.Scope>;
  }
>()("t3/computerUse/ComputerUseV2Bridge") {}

const isApprovalDecision = Schema.is(ProviderApprovalDecision);

const make = Effect.gen(function* () {
  const computer = yield* ComputerUse.ComputerUseService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sql = yield* SqlClient.SqlClient;

  const close = (
    threadId: ThreadId,
    requestId: RuntimeRequestId,
    expired = false,
    decision: ProviderApprovalDecision = "cancel",
  ) =>
    executor.withLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
        if (context.request?.viewcodeComputerUse !== true || context.request.status !== "pending")
          return;
        const now = yield* DateTime.now;
        const common = { threadId, occurredAt: now };
        const events: OrchestrationV2DomainEvent[] = [
          {
            ...common,
            id: EventId.make(`${requestId}:closed`),
            type: "runtime-request.updated",
            payload: {
              ...context.request,
              status: expired ? "expired" : decision === "cancel" ? "cancelled" : "resolved",
              resolvedAt: now,
              decision,
            },
          },
        ];
        if (context.node)
          events.push({
            ...common,
            id: EventId.make(`${requestId}:node:closed`),
            type: "node.updated",
            payload: {
              ...context.node,
              status: decision === "decline" || decision === "cancel" ? "cancelled" : "completed",
              completedAt: now,
            },
          });
        if (context.item)
          events.push({
            ...common,
            id: EventId.make(`${requestId}:item:closed`),
            type: "turn-item.updated",
            payload: { ...context.item, status: "cancelled", completedAt: now, updatedAt: now },
          });
        yield* sink.write({ events });
      }),
    );

  const publish = (event: ProviderRuntimeEvent) =>
    Effect.gen(function* () {
      if (!event.requestId || !event.requestId.startsWith("computer-use:")) return;
      if (event.type === "request.resolved") {
        yield* close(
          event.threadId,
          event.requestId,
          false,
          isApprovalDecision(event.payload.decision) ? event.payload.decision : "cancel",
        );
        return;
      }
      if (event.type !== "request.opened" || event.payload.requestType !== "permission_approval")
        return;
      const requestId = event.requestId;
      yield* executor.withLock(
        event.threadId,
        Effect.gen(function* () {
          const { run, providerThread, providerTurn } = yield* projections.getRunningTurnContext(
            event.threadId,
          );
          const providerSessionId = providerThread?.providerSessionId;
          if (
            run === undefined ||
            providerThread === undefined ||
            TurnId.make(run.id) !== event.turnId ||
            run.rootNodeId === null ||
            run.activeAttemptId === null ||
            providerSessionId == null ||
            providerThread?.providerInstanceId !== event.providerInstanceId
          )
            return yield* Effect.die("Computer approval has no active owning run");
          const now = yield* DateTime.now;
          const nodeId = NodeId.make(`computer-use:node:${event.requestId}`);
          const common = {
            threadId: event.threadId,
            runId: run.id,
            nodeId,
            driver: providerThread.driver,
            providerInstanceId: event.providerInstanceId,
            occurredAt: now,
          };
          const ordinal = yield* projections.getNextTurnItemOrdinal(event.threadId);
          const result = yield* sink.writeIfRunCurrent({
            threadId: event.threadId,
            runId: run.id,
            activeAttemptId: run.activeAttemptId,
            expectedStatus: "running",
            events: [
              {
                ...common,
                id: EventId.make(`${event.requestId}:node:opened`),
                type: "node.updated",
                payload: {
                  id: nodeId,
                  threadId: event.threadId,
                  runId: run.id,
                  parentNodeId: run.rootNodeId,
                  rootNodeId: run.rootNodeId,
                  kind: "approval_request",
                  status: "waiting",
                  countsForRun: true,
                  providerThreadId: providerThread.id,
                  providerTurnId: providerTurn?.id ?? null,
                  nativeItemRef: null,
                  runtimeRequestId: requestId,
                  checkpointScopeId: null,
                  startedAt: now,
                  completedAt: null,
                },
              },
              {
                ...common,
                id: EventId.make(`${event.requestId}:opened`),
                type: "runtime-request.updated",
                payload: {
                  id: requestId,
                  nodeId,
                  providerTurnId: providerTurn?.id ?? null,
                  nativeRequestRef: null,
                  kind: "permission",
                  status: "pending",
                  responseCapability: { type: "live", providerSessionId },
                  viewcodeComputerUse: true,
                  createdAt: now,
                  resolvedAt: null,
                },
              },
              {
                ...common,
                id: EventId.make(`${event.requestId}:item:opened`),
                type: "turn-item.updated",
                payload: {
                  id: TurnItemId.make(`computer-use:item:${event.requestId}`),
                  threadId: event.threadId,
                  runId: run.id,
                  nodeId,
                  providerThreadId: providerThread.id,
                  providerTurnId: providerTurn?.id ?? null,
                  nativeItemRef: null,
                  parentItemId: null,
                  ordinal,
                  type: "approval_request",
                  status: "waiting",
                  title: "Computer use",
                  startedAt: now,
                  completedAt: null,
                  updatedAt: now,
                  requestId,
                  requestKind: "permission",
                  ...(event.payload.detail === undefined ? {} : { prompt: event.payload.detail }),
                  ...(event.payload.appName === undefined
                    ? {}
                    : { appName: event.payload.appName }),
                  ...(event.payload.options === undefined
                    ? {}
                    : { options: event.payload.options }),
                },
              },
            ],
          });
          if (!result.committed)
            return yield* Effect.die("Computer approval's run stopped before publication");
        }),
      );
    }).pipe(Effect.orDie);

  return ComputerUseV2Bridge.of({
    start: () =>
      Effect.gen(function* () {
        // In-memory grants and waiters cannot survive a process restart.
        const pending = yield* sql<{
          readonly thread_id: ThreadId;
          readonly runtime_request_id: RuntimeRequestId;
        }>`SELECT thread_id, runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending' AND json_extract(payload_json, '$.viewcodeComputerUse') = 1`;
        for (const request of pending)
          yield* close(request.thread_id, request.runtime_request_id, true);
        yield* computer.attachRuntimeEventPublisher(publish);
        const sequence = yield* sink.latestSequence();
        yield* forkParked(
          Stream.runForEach(sink.stream({ afterSequence: sequence }), ({ event }) => {
            if (event.type === "runtime-request.updated")
              return computer.trackNativeApproval({
                threadId: event.threadId,
                requestId: event.payload.id,
                ...(event.runId === undefined ? {} : { turnId: TurnId.make(event.runId) }),
                pending: event.payload.status === "pending",
                userInput:
                  event.payload.kind === "user_input" || event.payload.kind === "auth_refresh",
              });
            if (
              event.type === "run.updated" &&
              ["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
                event.payload.status,
              )
            )
              return computer.endTurn(event.threadId, TurnId.make(event.payload.id));
            if (
              event.type === "thread.archived" ||
              event.type === "thread.deleted" ||
              event.type === "provider-session.detached"
            )
              return computer.releaseThread(event.threadId);
            return Effect.void;
          }).pipe(Effect.catchCause(() => computer.releaseAll)),
        );
        yield* Effect.addFinalizer(() => computer.releaseAll);
      }).pipe(Effect.mapError((cause) => new ComputerUseBridgeError({ cause }))),
  });
});
export const layer = Layer.effect(ComputerUseV2Bridge, make);
