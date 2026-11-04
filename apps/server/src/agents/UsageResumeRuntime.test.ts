import { expect, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as ActivityStore from "../review/ReviewActivityStoreV2.ts";
import * as Runtime from "./UsageResumeRuntime.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import { ownedLimitRecoveryCommand } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";

const threadId = ThreadId.make("native-usage-thread");
const now = DateTime.makeUnsafe("2026-10-18T00:00:00Z");
const resetAt = "2026-10-18T01:00:00Z";
const base = liveThreadShell(threadId);
const run: OrchestrationV2Run = {
  id: RunId.make("limited-run"),
  threadId,
  ordinal: 1,
  providerInstanceId: base.providerInstanceId,
  modelSelection: base.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("prompt"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "failed",
  requestedAt: now,
  startedAt: now,
  completedAt: now,
  checkpointId: null,
  contextHandoffId: null,
};
const event = (type: "run.created" | "run.updated", payload = run): OrchestrationV2DomainEvent => ({
  id: EventId.make(`${type}:${payload.id}`),
  threadId,
  occurredAt: now,
  type,
  payload,
});

it.effect(
  "delegated children defer to their lead while forked threads and side chats keep their own recovery",
  () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.UsageResumeRuntime;
      expect((yield* runtime.getThread(ThreadId.make("child")))?.child).toBe(true);
      expect((yield* runtime.getThread(ThreadId.make("fork")))?.child).toBe(false);
      expect((yield* runtime.getThread(ThreadId.make("side")))?.child).toBe(false);
    }).pipe(
      Effect.provide(
        Runtime.layer.pipe(
          Layer.provide(
            Layer.mock(ActivityStore.ReviewActivityStoreV2)({ append: () => Effect.void }),
          ),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: (id) =>
                Effect.succeed({
                  ...base,
                  id,
                  parentThreadId: threadId,
                  ...(id === "side" ? { kind: "sidechat" as const } : {}),
                  lineage: {
                    rootThreadId: threadId,
                    parentThreadId: threadId,
                    relationshipToParent:
                      id === "child"
                        ? ("subagent" as const)
                        : id === "fork"
                          ? ("fork" as const)
                          : null,
                  },
                }),
              streamDomainEvents: Stream.empty,
            }),
          ),
        ),
      ),
      Effect.scoped,
    ),
);

it.effect(
  "translates the native root-run terminal through the runtime factory without v1 sessions",
  () =>
    Effect.gen(function* () {
      const runtime = yield* Runtime.UsageResumeRuntime;
      const normalized = Option.getOrThrow(yield* Stream.runHead(yield* runtime.events));
      expect(normalized).toEqual({
        type: "failed",
        threadId,
        error: "A structured provider failure",
        request: run.id,
        usageLimit: true,
        recorded: { resetsAt: Date.parse(resetAt), windows: [] },
      });
    }).pipe(
      Effect.provide(
        Runtime.layer.pipe(
          Layer.provide(
            Layer.mock(ActivityStore.ReviewActivityStoreV2)({ append: () => Effect.void }),
          ),
          Layer.provide(
            Layer.mock(Threads.ThreadManagementService)({
              getThreadShell: () =>
                Effect.succeed({
                  ...base,
                  lastError: "A structured provider failure",
                  lastErrorClass: "usage_limit",
                  usageLimitResetAt: resetAt,
                }),
              streamDomainEvents: Stream.make(event("run.updated")),
            }),
          ),
        ),
      ),
      Effect.scoped,
    ),
);

it("arms snoozing without ever letting the upstream worker dispatch a second continuation", () => {
  const candidate = {
    ...base,
    status: "failed" as const,
    lastErrorClass: "usage_limit" as const,
    latestRunId: run.id,
    latestRunCompletedAt: now,
    usageLimitResetAt: resetAt,
    limitRecovery: null,
  };
  const armed = ownedLimitRecoveryCommand(candidate, true, DateTime.toEpochMillis(now), true, true);
  expect(armed).toMatchObject({
    type: "thread.metadata.update",
    limitRecovery: { autoResume: false, snooze: true },
  });
  const pending = {
    ...candidate,
    limitRecovery: { runId: run.id, resetAt, autoResume: true, snooze: false },
  };
  expect(ownedLimitRecoveryCommand(pending, true, Date.parse(resetAt) + 1, false, true)).toBeNull();
  expect(
    ownedLimitRecoveryCommand(pending, true, Date.parse(resetAt) + 1, false, false)?.type,
  ).toBe("message.dispatch");
});
