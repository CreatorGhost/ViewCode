import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  MessageId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as DateTime from "effect/DateTime";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ActivityStore from "../review/ReviewActivityStoreV2.ts";
import { liveThreadShell, idleThreadProjection } from "../mcp/McpToolAccess.testkit.ts";
import * as Messaging from "./AgentMessagingV2.ts";

const ROOT = ThreadId.make("thread:root");
const CHILD = ThreadId.make("thread:child");
const OTHER = ThreadId.make("thread:other-tree");
const now = DateTime.makeUnsafe("2026-10-18T00:00:00Z");

const harness = Effect.gen(function* () {
  const root = { ...liveThreadShell(ROOT), title: "Root", activeRunId: null };
  const child = {
    ...liveThreadShell(CHILD),
    title: "Child",
    activeRunId: null,
    lineage: {
      rootThreadId: ROOT,
      parentThreadId: ROOT,
      relationshipToParent: "subagent" as const,
    },
  };
  const shells = new Map([
    [ROOT, root],
    [CHILD, child],
    [OTHER, { ...liveThreadShell(OTHER), activeRunId: null }],
  ]);
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const recorded =
    yield* Queue.unbounded<
      Parameters<ActivityStore.ReviewActivityStoreV2["Service"]["append"]>[0]
    >();
  const sends: Array<ThreadManagement.ThreadManagementSendInput> = [];
  const commands: Array<{ readonly type: string; readonly threadId?: ThreadId }> = [];
  const runs = new Map<MessageId, OrchestrationV2Run>();
  const delegated: Array<
    Parameters<OrchestratorMcpService.OrchestratorMcpService["Service"]["delegateTask"]>[1]
  > = [];
  const layers = Layer.mergeAll(
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (id) => Effect.succeed(shells.get(id) ?? null),
      getShellSnapshot: () => Effect.succeed({ threads: [...shells.values()] } as never),
      getThreadProjection: () => Effect.succeed({ runs: [...runs.values()] } as never),
      getThreadRecords: (threadId) =>
        Effect.succeed({
          ...idleThreadProjection(shells.get(threadId) ?? root),
          messages: [...runs.values()]
            .filter((run) => run.threadId === threadId)
            .map((run) => ({
              id: MessageId.make(`answer:${run.id}`),
              threadId,
              runId: run.id,
              nodeId: null,
              role: "assistant" as const,
              text: "The result belongs to this message.",
              attachments: [],
              streaming: false,
              createdAt: now,
              updatedAt: now,
              createdBy: "agent" as const,
              creationSource: "provider" as const,
            })),
        }),
      sendToThread: (input) =>
        Effect.sync(() => {
          sends.push(input);
          const run = {
            id: RunId.make(`run:${input.messageId}`),
            userMessageId: input.messageId,
            threadId: input.threadId,
            status: "running",
            ordinal: sends.length,
          } as OrchestrationV2Run;
          runs.set(input.messageId, run);
          return { run, delivery: "started" } as ThreadManagement.ThreadManagementSendResult;
        }),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          return { sequence: 1, storedEvents: [] };
        }),
      stopDelegatedTasks: () => Effect.void,
      isProviderInstanceEnabledForProject: () => Effect.succeed(true),
      streamDomainEvents: Stream.fromQueue(events),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed([
        {
          instanceId: root.modelSelection.instanceId,
          driver: "codex",
          enabled: true,
          installed: true,
          availability: "available",
          status: "ready",
          auth: { status: "authenticated" },
          models: [{ slug: "gpt-5", name: "GPT-5", capabilities: null }],
        } as unknown as ServerProvider,
      ]),
    }),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
      delegateTask: (_scope, input) =>
        Effect.sync(() => {
          delegated.push(input);
          return {
            taskId: "task:delegate",
            childThreadId: CHILD,
            childRunId: null,
            status: "queued",
          } as never;
        }),
    }),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("environment:test")),
    }),
    Layer.mock(ActivityStore.ReviewActivityStoreV2)({
      append: (activity) => Queue.offer(recorded, activity).pipe(Effect.asVoid),
    }),
  );
  const context = yield* Layer.build(
    Messaging.layer.pipe(Layer.provide(layers), Layer.provide(NodeServices.layer)),
  );
  const messaging = Context.get(context, Messaging.AgentMessaging);
  return { messaging, sends, commands, events, recorded, runs, delegated };
});

it.effect("isolates agent trees and keeps native sender provenance on direct messages", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    expect((yield* h.messaging.listAgents(ROOT)).map((entry) => entry.id)).toEqual([ROOT, CHILD]);
    const error = yield* h.messaging
      .sendMessage(ROOT, { to: OTHER, message: "private" })
      .pipe(Effect.flip);
    expect(error.message).toContain("not in your agent tree");
    expect(h.sends).toEqual([]);
    const result = yield* h.messaging.sendMessage(ROOT, {
      to: CHILD,
      message: "Please check it",
      replyExpected: true,
    });
    expect(h.sends[0]).toMatchObject({
      senderThreadId: ROOT,
      createdBy: "agent",
      creationSource: "server",
      mode: "queue",
      messageId: result.messageId,
    });
    expect(h.sends[0]?.text).toContain(`from-id="${ROOT}"`);
  }).pipe(Effect.scoped),
);

it.effect("holds stopped mail until resume and discards it without waking the receiver", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.messaging.stop({ threadId: CHILD, scope: "thread" });
    const first = yield* h.messaging.sendMessage(ROOT, { to: CHILD, message: "Held" });
    expect(first.delivery).toBe("queued");
    expect(h.sends).toEqual([]);
    yield* h.messaging.resume({ threadId: CHILD, scope: "thread" });
    expect(h.sends).toHaveLength(1);
    yield* h.messaging.stop({ threadId: CHILD, scope: "thread" });
    yield* h.messaging.sendMessage(ROOT, { to: CHILD, message: "Discarded" });
    yield* h.messaging.discard({ threadId: CHILD, scope: "thread" });
    yield* h.messaging.resume({ threadId: CHILD, scope: "thread" });
    expect(h.sends).toHaveLength(1);
  }).pipe(Effect.scoped),
);

it.effect(
  "binds automatic replies to the delivered native run and sends its final answer once",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.messaging.start();
      const sent = yield* h.messaging.sendMessage(ROOT, {
        to: CHILD,
        message: "Check",
        replyExpected: true,
      });
      yield* Queue.take(h.recorded);
      const run = h.runs.get(MessageId.make(sent.messageId))!;
      yield* Queue.offer(h.events, {
        type: "run.updated",
        id: "event:complete",
        threadId: CHILD,
        occurredAt: now,
        payload: { ...run, status: "completed" },
      } as OrchestrationV2DomainEvent);
      const reply = yield* Queue.take(h.recorded);
      expect(reply.threadId).toBe(CHILD);
      expect(h.sends[1]).toMatchObject({ threadId: ROOT, senderThreadId: CHILD });
      expect(h.sends[1]?.text).toContain(`in-reply-to="${sent.messageId}"`);
      yield* h.messaging.drain;
      expect(h.sends).toHaveLength(2);
    }).pipe(Effect.scoped),
);

it.effect("notifies a requester when the addressed native run fails without an answer", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    yield* h.messaging.start();
    const sent = yield* h.messaging.sendMessage(ROOT, {
      to: CHILD,
      message: "Please inspect this change",
      replyExpected: true,
    });
    yield* Queue.take(h.recorded);
    const run = h.runs.get(MessageId.make(sent.messageId))!;
    // No assistant message is available for this failed run.
    h.runs.delete(run.userMessageId);
    yield* Queue.offer(h.events, {
      type: "run.updated",
      id: importFailureEventId,
      threadId: CHILD,
      occurredAt: now,
      payload: { ...run, status: "failed" },
    });
    yield* Queue.take(h.recorded);
    expect(h.sends[1]?.text).toContain("failed without an answer");
    expect(h.sends[1]?.text).toContain(`in-reply-to="${sent.messageId}"`);
  }).pipe(Effect.scoped),
);
const importFailureEventId = EventId.make("agent-native-failed");

it.effect("rejects a forged reply id before creating a native message", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const error = yield* h.messaging
      .sendMessage(CHILD, { to: ROOT, message: "spoof", responseId: "missing" })
      .pipe(Effect.flip);
    expect(error.message).toContain("does not belong");
    expect(h.sends).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("spawns through upstream delegated tasks in an isolated worktree", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    const spawned = yield* h.messaging.spawnAgent(ROOT, {
      name: "Child",
      prompt: "Review the changes",
    });
    expect(spawned.agentId).toBe(CHILD);
    expect(h.delegated[0]).toMatchObject({
      isolation: "worktree",
      mode: "async",
      task: "Review the changes",
      target: { providerInstanceId: "codex", model: "gpt-5" },
    });
    expect(h.commands).toEqual([]);
  }).pipe(Effect.scoped),
);

it.effect("caps automatic reply chains at 24 hops", () =>
  Effect.gen(function* () {
    const h = yield* harness;
    let from = ROOT;
    let to = CHILD;
    let sent = yield* h.messaging.sendMessage(from, { to, message: "start", replyExpected: true });
    for (let hop = 1; hop < Messaging.AGENT_MESSAGE_MAX_HOPS; hop += 1) {
      [from, to] = [to, from];
      sent = yield* h.messaging.sendMessage(from, {
        to,
        message: `reply ${hop}`,
        responseId: sent.messageId,
        replyExpected: true,
      });
    }
    const refused = yield* h.messaging
      .sendMessage(to, { to: from, message: "one more", responseId: sent.messageId })
      .pipe(Effect.flip);
    expect(refused.message).toContain("24 automatic hops");
    expect(h.sends).toHaveLength(24);
  }).pipe(Effect.scoped),
);
