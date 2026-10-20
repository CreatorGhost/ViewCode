import {
  EventId,
  NodeId,
  OrchestratorMcpFailure,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type ProviderApprovalDecision,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";

/** Long enough to step away from the keyboard, inside the providers' 65-minute tool budget. */
const CONFIRMATION_TIMEOUT = Duration.minutes(30);
const POLL_INTERVAL = Duration.millis(500);

export interface RockBotConfirmationRequest {
  /** The RockBot thread asking; the question shows in its composer. */
  readonly threadId: ThreadId;
  /** One line, such as "Send to Timeline tests". */
  readonly title: string;
  /** What exactly would be sent. */
  readonly detail: string;
}

/**
 * RockBot's sends and answers wait here for its user. The question is an ordinary
 * approval in the RockBot thread, so every client shows it and counts it as
 * needing the user, but the server answers it itself: no provider ever sees it,
 * and nothing the agent says can stand in for the user's click.
 */
export class RockBotConfirmation extends Context.Service<
  RockBotConfirmation,
  {
    readonly confirm: (
      request: RockBotConfirmationRequest,
    ) => Effect.Effect<boolean, OrchestratorMcpFailure>;
  }
>()("t3/rockbot/RockBotConfirmation") {}

const isMcpFailure = Schema.is(OrchestratorMcpFailure);
const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

export const make = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;

  const close = (threadId: ThreadId, requestId: RuntimeRequestId, expired: boolean) =>
    executor.withLock(
      threadId,
      Effect.gen(function* () {
        const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
        if (
          context.request?.viewcodeRockBotConfirm !== true ||
          context.request.status !== "pending"
        )
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
              status: expired ? "expired" : "cancelled",
              resolvedAt: now,
              decision: "cancel",
            },
          },
        ];
        if (context.node)
          events.push({
            ...common,
            id: EventId.make(`${requestId}:node:closed`),
            type: "node.updated",
            payload: { ...context.node, status: "cancelled", completedAt: now },
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

  // A waiting tool call does not survive a restart, so neither does its question.
  const stale = yield* sql<{
    readonly thread_id: ThreadId;
    readonly runtime_request_id: RuntimeRequestId;
  }>`SELECT thread_id, runtime_request_id FROM orchestration_v2_projection_runtime_requests WHERE status = 'pending' AND json_extract(payload_json, '$.viewcodeRockBotConfirm') = 1`.pipe(
    Effect.orElseSucceed(() => []),
  );
  for (const request of stale)
    yield* close(request.thread_id, request.runtime_request_id, true).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not close a stale RockBot confirmation", { cause }),
      ),
    );

  const open = (request: RockBotConfirmationRequest, requestId: RuntimeRequestId) =>
    executor.withLock(
      request.threadId,
      Effect.gen(function* () {
        const { run, providerThread, providerTurn } = yield* projections.getRunningTurnContext(
          request.threadId,
        );
        const providerSessionId = providerThread?.providerSessionId;
        if (
          run === undefined ||
          providerThread === undefined ||
          run.rootNodeId === null ||
          run.activeAttemptId === null ||
          providerSessionId == null
        )
          return false;
        const now = yield* DateTime.now;
        const nodeId = NodeId.make(`${requestId}:node`);
        const common = {
          threadId: request.threadId,
          runId: run.id,
          nodeId,
          driver: providerThread.driver,
          providerInstanceId: providerThread.providerInstanceId,
          occurredAt: now,
        };
        const ordinal = yield* projections.getNextTurnItemOrdinal(request.threadId);
        const result = yield* sink.writeIfRunCurrent({
          threadId: request.threadId,
          runId: run.id,
          activeAttemptId: run.activeAttemptId,
          expectedStatus: "running",
          events: [
            {
              ...common,
              id: EventId.make(`${requestId}:node:opened`),
              type: "node.updated",
              payload: {
                id: nodeId,
                threadId: request.threadId,
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
              id: EventId.make(`${requestId}:opened`),
              type: "runtime-request.updated",
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: providerTurn?.id ?? null,
                nativeRequestRef: null,
                kind: "permission",
                status: "pending",
                responseCapability: { type: "live", providerSessionId },
                viewcodeRockBotConfirm: true,
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              ...common,
              id: EventId.make(`${requestId}:item:opened`),
              type: "turn-item.updated",
              payload: {
                id: TurnItemId.make(`${requestId}:item`),
                threadId: request.threadId,
                runId: run.id,
                nodeId,
                providerThreadId: providerThread.id,
                providerTurnId: providerTurn?.id ?? null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal,
                type: "approval_request",
                status: "waiting",
                title: request.title,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                requestKind: "permission",
                prompt: request.detail,
                appName: request.title,
                options: [
                  { decision: "decline", label: "Don't send" },
                  { decision: "accept", label: "Send" },
                ],
              },
            },
          ],
        });
        return result.committed;
      }),
    );

  const decision = (threadId: ThreadId, requestId: RuntimeRequestId) =>
    Effect.gen(function* () {
      while (true) {
        const context = yield* projections.getRuntimeResponseContext(threadId, requestId);
        const request = context.request;
        if (request === undefined) return "cancel" as ProviderApprovalDecision;
        if (request.status !== "pending") return request.decision ?? "cancel";
        yield* Effect.sleep(POLL_INTERVAL);
      }
    });

  const confirm = (request: RockBotConfirmationRequest) =>
    Effect.gen(function* () {
      const requestId = RuntimeRequestId.make(`rockbot-confirm:${yield* crypto.randomUUIDv4()}`);
      if (!(yield* open(request, requestId)))
        return yield* failure(
          "parent_not_active",
          "RockBot can ask for confirmation only during its own running turn.",
        );
      const answered = yield* decision(request.threadId, requestId).pipe(
        Effect.timeoutOption(CONFIRMATION_TIMEOUT),
        // An aborted tool call must not leave a question the user could still answer.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : close(request.threadId, requestId, false),
        ),
      );
      if (Option.isNone(answered)) {
        yield* close(request.threadId, requestId, true);
        return false;
      }
      return answered.value === "accept" || answered.value === "acceptForSession";
    }).pipe(
      Effect.mapError((error) =>
        isMcpFailure(error)
          ? error
          : failure("orchestration_error", `Could not ask the user to confirm: ${error.message}`),
      ),
    );

  return RockBotConfirmation.of({ confirm });
});

export const layer = Layer.effect(RockBotConfirmation, make);

/**
 * The gate every RockBot write passes: other callers go straight through; RockBot
 * waits for its user and fails with `user_declined` unless they press Send. A host
 * without the service refuses RockBot rather than letting it write unasked.
 */
export const confirmIfRockBot = (
  caller: { readonly id: ThreadId; readonly kind?: string | null | undefined } | undefined,
  request: { readonly title: string; readonly detail: string },
) =>
  Effect.gen(function* () {
    if (caller?.kind !== "orchestrator") return;
    const service = yield* Effect.serviceOption(RockBotConfirmation);
    if (Option.isNone(service)) {
      return yield* failure(
        "capability_denied",
        "This server cannot ask the user to confirm, so RockBot cannot send.",
      );
    }
    const confirmed = yield* service.value.confirm({ threadId: caller.id, ...request });
    if (!confirmed) {
      return yield* failure(
        "user_declined",
        "The user chose not to send this. Do not retry it unless they ask again.",
      );
    }
  });
