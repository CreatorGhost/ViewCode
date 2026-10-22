import {
  AgentControlError,
  type AgentControlInput,
  type AgentControlResult,
  type AgentControlSnapshot,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  ProviderInstanceId,
  type RunId,
  ThreadId,
  isProviderAvailable,
} from "@t3tools/contracts";
import {
  AGENT_MESSAGE_SENT_ACTIVITY_KIND,
  formatAgentMessage,
} from "@t3tools/shared/agentMessages";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as OrchestratorMcpService from "../mcp/OrchestratorMcpService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ActivityStore from "../review/ReviewActivityStoreV2.ts";
import {
  applyModelTuning,
  describeModelTuning,
  selectedEffort,
  type ModelTuning,
} from "./modelOptions.ts";
import { searchThreadHistory, type HistoryMatch } from "./searchHistory.ts";

export const AGENT_MESSAGE_MAX_HOPS = 24;
export const AGENT_CONTINUE_PROMPT = "Continue where you left off.";
export const USAGE_RESET_CONTINUE_PROMPT =
  "The usage limit has reset. Continue exactly where you left off and finish the task.";

export class AgentMessagingError extends Schema.TaggedError<AgentMessagingError>()(
  "AgentMessagingError",
  {
    reason: Schema.String,
  },
) {
  override get message() {
    return this.reason;
  }
}
export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly relation: "you" | "parent" | "child" | "sibling" | "other";
  readonly provider: string;
  /** The model the agent is configured to run; every turn ViewCode starts names it. */
  readonly model: string;
  /**
   * The model its live provider session reports, when that differs from
   * `model` (a provider can come back on its default after an error). Its
   * next turn moves it back to `model`.
   */
  readonly runningModel?: string;
  /** Reasoning effort set on the agent; absent means the model's default. */
  readonly effort?: string;
  readonly status: "running" | "idle" | "error" | "stopped" | "new" | "paused";
  readonly queuedMessages: number;
  /** Set while the agent's provider usage limit is known to hold. */
  readonly outOfUsage?: {
    /** Ready to relay, e.g. "out of usage until 9:00 AM (last checked 7:42 AM)". */
    readonly summary: string;
    readonly resetsAt?: string;
    readonly retryAfter: string;
    readonly lastCheckedAt: string;
  };
}

export interface ProviderModels {
  readonly providerId: string;
  readonly name: string;
  readonly driver: string;
  readonly usable: boolean;
  readonly note?: string;
  /** The provider's own usage windows, when it reports them. */
  readonly usage?: {
    readonly exhausted: boolean;
    readonly resetsAt?: string;
    readonly checkedAt: string;
  };
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string } & ModelTuning>;
}

export interface SendResult {
  readonly messageId: string;
  readonly delivery: "started" | "queued";
  readonly note?: string;
}

export interface SpawnResult extends SendResult {
  readonly agentId: string;
  readonly name: string;
  readonly taskId?: string;
}

export interface AgentMessagingShape {
  readonly listAgents: (
    caller: ThreadId,
  ) => Effect.Effect<ReadonlyArray<AgentSummary>, AgentMessagingError>;
  readonly listModels: () => Effect.Effect<ReadonlyArray<ProviderModels>>;
  readonly spawnAgent: (
    caller: ThreadId,
    input: {
      readonly name: string;
      readonly prompt: string;
      readonly providerId?: string | undefined;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
      readonly fastMode?: boolean | undefined;
      readonly replyExpected?: boolean | undefined;
      readonly task?: string | undefined;
    },
  ) => Effect.Effect<SpawnResult, AgentMessagingError>;
  readonly sendMessage: (
    caller: ThreadId,
    input: {
      readonly to: string;
      readonly message: string;
      readonly replyExpected?: boolean | undefined;
      readonly responseId?: string | undefined;
    },
  ) => Effect.Effect<SendResult, AgentMessagingError>;
  readonly searchHistory: (
    caller: ThreadId,
    input: {
      readonly query: string;
      readonly agent?: string | undefined;
      readonly limit?: number | undefined;
    },
  ) => Effect.Effect<ReadonlyArray<HistoryMatch>, AgentMessagingError>;
  readonly readTranscript: (
    caller: ThreadId,
    input: { readonly agent: string; readonly lastMessages?: number | undefined },
  ) => Effect.Effect<string, AgentMessagingError>;
  readonly configureAgent: (
    caller: ThreadId,
    input: {
      readonly agent: string;
      readonly providerId?: string | undefined;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
      readonly fastMode?: boolean | undefined;
    },
  ) => Effect.Effect<
    { readonly agentId: string; readonly appliesTo: "next-turn" },
    AgentMessagingError
  >;
  /** Pauses the agents in scope and interrupts the ones that are running. */
  readonly stop: (input: AgentControlInput) => Effect.Effect<AgentControlResult, AgentControlError>;
  /** Unpauses, continues a stopped turn and starts held messages. */
  readonly resume: (
    input: AgentControlInput,
  ) => Effect.Effect<AgentControlResult, AgentControlError>;
  /** Unpauses and drops held messages and the stopped turn, without waking anyone. */
  readonly discard: (
    input: AgentControlInput,
  ) => Effect.Effect<AgentControlResult, AgentControlError>;
  /**
   * Continues a thread stopped on a limit, clearing its out-of-quota mark:
   * the usage-reset prompt once a usage limit reset, a plain "continue" after
   * a transient throttle. Mail queued for the agent follows when that turn
   * ends. Says why nothing started when the thread is gone or archived,
   * paused by the user, or busy.
   */
  readonly continueAfterLimit: (
    threadId: ThreadId,
    messageId: MessageId,
    reason: "usage" | "transient",
  ) => Effect.Effect<"started" | "busy" | "paused" | "gone", AgentMessagingError>;
  /**
   * Starts a server-written turn (a pull request watch wake) when the thread is free. "held"
   * means the user paused it or it is out of usage; "busy" means a turn or queued mail comes
   * first. Either way the caller tries again later.
   */
  readonly wake: (
    threadId: ThreadId,
    messageId: MessageId,
    text: string,
  ) => Effect.Effect<"started" | "busy" | "held" | "gone", AgentMessagingError>;
  /**
   * Records what happens to a thread stopped on a usage limit (`resumeAt` when
   * an automatic resume is scheduled), or clears it with null. Clients read it
   * from `controlChanges`.
   */
  readonly setUsageResume: (
    threadId: ThreadId,
    state: { readonly resumeAt?: string } | null,
  ) => Effect.Effect<void>;
  /** Paused agents and queue lengths: the current value, then every change. */
  readonly controlChanges: Stream.Stream<AgentControlSnapshot>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class AgentMessaging extends Context.Service<AgentMessaging, AgentMessagingShape>()(
  "t3/agents/AgentMessagingV2/AgentMessaging",
) {}

interface Delivery {
  readonly messageId: MessageId;
  readonly fromThreadId: ThreadId;
  readonly fromName: string;
  readonly toThreadId: ThreadId;
  readonly body: string;
  readonly replyExpected: boolean;
  readonly inReplyTo: string | null;
  readonly chainId: string;
  readonly hop: number;
  runId: RunId | null;
  replied: boolean;
  queued?: boolean;
}

export const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const orchestrator = yield* OrchestratorMcpService.OrchestratorMcpService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const activities = yield* ActivityStore.ReviewActivityStoreV2;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  const deliveries = new Map<MessageId, Delivery>();
  const held = new Map<ThreadId, Delivery[]>();
  const interrupted = new Map<ThreadId, Delivery | null>();
  const paused = new Set<ThreadId>();
  const usage = new Map<ThreadId, { readonly resumeAt?: string }>();
  const controls = yield* SubscriptionRef.make<AgentControlSnapshot>([]);
  const gate = yield* Semaphore.make(1);
  let started = false;
  const failure = (cause: unknown) =>
    new AgentMessagingError({ reason: cause instanceof Error ? cause.message : String(cause) });
  const controlFailure = (cause: unknown) =>
    new AgentControlError({ detail: failure(cause).message });
  const shells = threads.getShellSnapshot().pipe(Effect.map((snapshot) => snapshot.threads));
  const requireThread = Effect.fn("AgentMessagingV2.requireThread")(function* (id: ThreadId) {
    const thread = yield* threads.getThreadShell(id);
    if (thread === null || thread.archivedAt !== null)
      return yield* failure("This agent no longer exists or is archived.");
    return thread;
  });
  const root = (thread: OrchestrationV2ThreadShell) => thread.lineage.rootThreadId;
  const treeOf = Effect.fn("AgentMessagingV2.tree")(function* (caller: ThreadId) {
    const thread = yield* requireThread(caller);
    const tree = (yield* shells).filter(
      (candidate) => candidate.archivedAt === null && root(candidate) === root(thread),
    );
    return { thread, tree };
  });
  const resolve = Effect.fn("AgentMessagingV2.resolve")(function* (
    caller: ThreadId,
    target: string,
  ) {
    const context = yield* treeOf(caller);
    const matches = context.tree.filter(
      (thread) => thread.id === target || thread.title === target,
    );
    if (matches.length !== 1)
      return yield* failure(
        matches.length === 0
          ? "The agent is not in your agent tree."
          : "Several agents have that name. Use its id.",
      );
    return { ...context, target: matches[0]! };
  });
  const queuedCount = (threadId: ThreadId) =>
    (held.get(threadId)?.length ?? 0) +
    [...deliveries.values()].filter((entry) => entry.toThreadId === threadId && entry.queued)
      .length;
  const publish = Effect.suspend(() =>
    SubscriptionRef.set(
      controls,
      [
        ...new Set([
          ...paused,
          ...held.keys(),
          ...usage.keys(),
          ...[...deliveries.values()]
            .filter((entry) => entry.queued)
            .map((entry) => entry.toThreadId),
        ]),
      ].map((threadId) => ({
        threadId,
        paused: paused.has(threadId),
        queued: queuedCount(threadId),
        ...(usage.has(threadId) ? { usageResume: usage.get(threadId)! } : {}),
      })),
    ),
  );
  const record = Effect.fn("AgentMessagingV2.record")(function* (
    from: OrchestrationV2ThreadShell,
    to: OrchestrationV2ThreadShell,
    message: Delivery,
    delivery: "started" | "queued",
    kind: "message" | "spawn" = "message",
  ) {
    yield* activities.append({
      commandId: CommandId.make(`viewcode:agent-sent:${message.messageId}`),
      threadId: from.id,
      activity: {
        id: EventId.make(`viewcode:agent-sent:${message.messageId}`),
        tone: "info",
        kind: AGENT_MESSAGE_SENT_ACTIVITY_KIND,
        summary: `${kind === "spawn" ? "Started" : "Sent a message to"} ${to.title}`,
        payload: {
          messageId: message.messageId,
          toThreadId: to.id,
          toName: to.title,
          body: message.body,
          replyExpected: message.replyExpected,
          inReplyTo: message.inReplyTo,
          kind,
          delivery,
          chainId: message.chainId,
          hop: message.hop,
        },
        turnId: null,
        createdAt: DateTime.formatIso(yield* DateTime.now),
      },
    });
  });
  const deliver = Effect.fn("AgentMessagingV2.deliver")(function* (message: Delivery) {
    const receiver = yield* requireThread(message.toThreadId);
    deliveries.set(message.messageId, message);
    const accepted = yield* threads
      .sendToThread({
        commandId: CommandId.make(`viewcode:agent-message:${message.messageId}`),
        projectId: receiver.projectId,
        threadId: receiver.id,
        messageId: message.messageId,
        senderThreadId: message.fromThreadId,
        text: formatAgentMessage(message),
        attachments: [],
        modelSelection: receiver.modelSelection,
        mode: "queue",
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(
        Effect.onError(() =>
          Effect.sync(() => {
            deliveries.delete(message.messageId);
          }),
        ),
      );
    message.runId = accepted.run.id;
    message.queued = accepted.delivery === "queued";
    return accepted.delivery === "queued" ? ("queued" as const) : ("started" as const);
  });
  const send = Effect.fn("AgentMessagingV2.send")(function* (
    caller: ThreadId,
    input: Parameters<AgentMessagingShape["sendMessage"]>[1],
  ) {
    const { thread, target } = yield* resolve(caller, input.to);
    const response =
      input.responseId === undefined ? undefined : deliveries.get(MessageId.make(input.responseId));
    if (
      input.responseId !== undefined &&
      (response === undefined ||
        response.toThreadId !== caller ||
        response.fromThreadId !== target.id)
    )
      return yield* failure("That response id does not belong to a message from this agent.");
    const incoming =
      response ??
      [...deliveries.values()].find(
        (message) => message.toThreadId === caller && message.runId === thread.activeRunId,
      );
    const hop = (incoming?.hop ?? -1) + 1;
    if (hop >= AGENT_MESSAGE_MAX_HOPS)
      return yield* failure(
        `This conversation reached ${AGENT_MESSAGE_MAX_HOPS} automatic hops. Summarize the state for the user.`,
      );
    const messageId = MessageId.make(yield* uuid);
    const message: Delivery = {
      messageId,
      fromThreadId: caller,
      fromName: thread.title,
      toThreadId: target.id,
      body: input.message,
      replyExpected: input.replyExpected ?? false,
      inReplyTo: input.responseId ?? null,
      chainId: incoming?.chainId ?? messageId,
      hop,
      runId: null,
      replied: false,
    };
    const delivery = paused.has(target.id) ? ("queued" as const) : yield* deliver(message);
    if (paused.has(target.id)) held.set(target.id, [...(held.get(target.id) ?? []), message]);
    if (response !== undefined) response.replied = true;
    yield* record(thread, target, message, delivery);
    yield* publish;
    return { messageId, delivery };
  });
  const sendMessage: AgentMessagingShape["sendMessage"] = (caller, input) =>
    send(caller, input).pipe(gate.withPermit, Effect.mapError(failure));
  const onEvent = Effect.fn("AgentMessagingV2.event")(function* (
    event: OrchestrationV2DomainEvent,
  ) {
    if (
      event.type === "message.updated" &&
      event.payload.role === "user" &&
      event.payload.createdBy === "user" &&
      event.payload.senderThreadId === undefined &&
      event.payload.scheduledTaskId === undefined
    ) {
      if (paused.delete(event.threadId)) {
        yield* flush(event.threadId);
        yield* publish;
      }
      return;
    }
    if (event.type !== "run.updated") return;
    const pending = deliveries.get(event.payload.userMessageId);
    if (pending !== undefined) {
      pending.queued = event.payload.status === "queued";
      yield* publish;
    }
    if (
      !["completed", "failed", "cancelled", "interrupted", "rolled_back"].includes(
        event.payload.status,
      )
    )
      return;
    const run = event.payload;
    const delivery = deliveries.get(run.userMessageId);
    if (delivery === undefined) return;
    if (run.status === "interrupted" && paused.has(run.threadId))
      interrupted.set(run.threadId, delivery);
    if (
      delivery.replyExpected &&
      !delivery.replied &&
      (run.status === "completed" || run.status === "failed")
    ) {
      const records = yield* threads.getThreadRecords(run.threadId, ["messages"]);
      const answer = records.messages
        .filter(
          (message) =>
            message.runId === run.id && message.role === "assistant" && !message.streaming,
        )
        .at(-1)
        ?.text.trim();
      const shell = answer ? null : yield* threads.getThreadShell(run.threadId);
      const body =
        answer ||
        (run.status === "failed"
          ? `(failed without an answer: ${shell?.lastError ?? "the provider could not finish this turn"})`
          : "(finished without a written answer)");
      yield* send(delivery.toThreadId, {
        to: delivery.fromThreadId,
        message: body.slice(-24_000),
        responseId: delivery.messageId,
      });
    }
    deliveries.delete(delivery.messageId);
    yield* publish;
  });
  const worker = yield* makeDrainableWorker((event: OrchestrationV2DomainEvent) =>
    onEvent(event).pipe(gate.withPermit),
  );
  const flush = Effect.fn("AgentMessagingV2.flush")(function* (threadId: ThreadId) {
    const queue = held.get(threadId) ?? [];
    for (const message of queue) {
      yield* deliver(message);
      held.set(
        threadId,
        (held.get(threadId) ?? []).filter((candidate) => candidate !== message),
      );
    }
    if (held.get(threadId)?.length === 0) held.delete(threadId);
  });
  const targets = (input: AgentControlInput) =>
    treeOf(input.threadId).pipe(
      Effect.map(({ thread, tree }) => (input.scope === "thread" ? [thread] : tree)),
    );
  const stop: AgentMessagingShape["stop"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* targets(input);
      for (const thread of scope) {
        paused.add(thread.id);
        if (thread.activeRunId !== null)
          interrupted.set(
            thread.id,
            [...deliveries.values()].find((entry) => entry.runId === thread.activeRunId) ?? null,
          );
        yield* threads.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`viewcode:agent-stop:${yield* uuid}`),
          threadId: thread.id,
        });
        yield* threads.stopDelegatedTasks({
          threadId: thread.id,
          commandId: CommandId.make(`viewcode:stop-children:${yield* uuid}`),
        });
      }
      yield* publish;
      return { threadIds: scope.map((thread) => thread.id) };
    }).pipe(gate.withPermit, Effect.mapError(controlFailure));
  const resume: AgentMessagingShape["resume"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* targets(input);
      for (const thread of scope) {
        paused.delete(thread.id);
        yield* threads.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`viewcode:agent-resume:${yield* uuid}`),
          threadId: thread.id,
        });
        yield* flush(thread.id);
        if (interrupted.has(thread.id)) {
          const prior = interrupted.get(thread.id);
          if (prior != null) {
            deliveries.delete(prior.messageId);
            yield* deliver({
              ...prior,
              messageId: MessageId.make(yield* uuid),
              body: AGENT_CONTINUE_PROMPT,
              runId: null,
            });
          } else if (thread.activeRunId === null) {
            yield* threads.sendToThread({
              projectId: thread.projectId,
              threadId: thread.id,
              commandId: CommandId.make(`viewcode:agent-continue:${yield* uuid}`),
              messageId: MessageId.make(yield* uuid),
              text: AGENT_CONTINUE_PROMPT,
              attachments: [],
              mode: "queue",
              createdBy: "user",
              creationSource: "server",
            });
          }
          interrupted.delete(thread.id);
        }
      }
      yield* publish;
      return { threadIds: scope.map((thread) => thread.id) };
    }).pipe(gate.withPermit, Effect.mapError(controlFailure));
  const discard: AgentMessagingShape["discard"] = (input) =>
    Effect.gen(function* () {
      const scope = yield* targets(input);
      for (const thread of scope) {
        held.delete(thread.id);
        paused.delete(thread.id);
        interrupted.delete(thread.id);
        const projection = yield* threads.getThreadProjection(thread.id);
        for (const run of projection.runs.filter(
          (run) => run.status === "queued" && run.queueHeld === true,
        ))
          yield* threads.dispatch({
            type: "queued-run.cancel",
            commandId: CommandId.make(`viewcode:discard-mail:${run.id}`),
            threadId: thread.id,
            runId: run.id,
          });
      }
      yield* publish;
      return { threadIds: scope.map((thread) => thread.id) };
    }).pipe(gate.withPermit, Effect.mapError(controlFailure));
  const selectModel = Effect.fn("AgentMessagingV2.selectModel")(function* (
    thread: OrchestrationV2ThreadShell,
    input: {
      readonly providerId?: string | undefined;
      readonly model?: string | undefined;
      readonly effort?: string | undefined;
      readonly fastMode?: boolean | undefined;
    },
  ) {
    const providers = yield* providerRegistry.getProviders;
    const instanceId =
      input.providerId === undefined
        ? thread.modelSelection.instanceId
        : ProviderInstanceId.make(input.providerId);
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    if (
      provider === undefined ||
      !provider.enabled ||
      provider.disabledByAdmin ||
      !isProviderAvailable(provider)
    )
      return yield* failure("That provider is not enabled and available.");
    if (
      !(yield* threads.isProviderInstanceEnabledForProject({
        projectId: thread.projectId,
        instanceId,
      }))
    )
      return yield* failure("That provider is disabled for this project.");
    const modelId =
      input.model ??
      (instanceId === thread.modelSelection.instanceId
        ? thread.modelSelection.model
        : provider.models[0]?.slug);
    const model = provider.models.find((candidate) => candidate.slug === modelId);
    if (model === undefined)
      return yield* failure("That model is not advertised by this provider.");
    const tuning = applyModelTuning({
      driver: provider.driver,
      model: model.slug,
      capabilities: model.capabilities,
      existing:
        instanceId === thread.modelSelection.instanceId &&
        model.slug === thread.modelSelection.model
          ? thread.modelSelection.options
          : undefined,
      effort: input.effort,
      fastMode: input.fastMode,
    });
    if ("error" in tuning) return yield* failure(tuning.error);
    return {
      instanceId,
      model: model.slug,
      ...(tuning.options === undefined ? {} : { options: tuning.options }),
    } satisfies ModelSelection;
  });
  const spawnAgent: AgentMessagingShape["spawnAgent"] = (caller, input) =>
    Effect.gen(function* () {
      const thread = yield* requireThread(caller);
      const selection = yield* selectModel(thread, input);
      const supplied = yield* Effect.serviceOption(McpInvocationContext.McpInvocationContext);
      if (Option.isSome(supplied) && supplied.value.thread?.threadId !== caller)
        return yield* failure("The calling thread does not match this credential.");
      const scope: McpInvocationContext.McpInvocationScope = Option.isSome(supplied)
        ? supplied.value
        : {
            environmentId: yield* environment.getEnvironmentId,
            requestNamespace: `viewcode:spawn:${yield* uuid}`,
            thread: {
              threadId: caller,
              providerInstanceId: thread.modelSelection.instanceId,
              providerSessionId: "viewcode-server",
            },
            client: undefined,
            capabilities: new Set(["orchestration", "pull-requests"]),
            issuedAt: 0,
          };
      const task = yield* orchestrator.delegateTask(scope, {
        title: input.name,
        task: input.prompt,
        target: {
          providerInstanceId: selection.instanceId,
          model: selection.model,
          options: selection.options,
        },
        isolation: "worktree",
        mode: "async",
      });
      const messageId = MessageId.make(task.taskId);
      const child = yield* requireThread(task.childThreadId);
      yield* record(
        thread,
        child,
        {
          messageId,
          fromThreadId: caller,
          fromName: thread.title,
          toThreadId: child.id,
          body: input.prompt,
          replyExpected: input.replyExpected ?? true,
          inReplyTo: null,
          chainId: messageId,
          hop: 0,
          runId: task.childRunId,
          replied: false,
        },
        task.status === "queued" ? "queued" : "started",
        "spawn",
      );
      return {
        taskId: task.taskId,
        agentId: child.id,
        name: child.title,
        messageId,
        delivery: task.status === "queued" ? ("queued" as const) : ("started" as const),
      };
    }).pipe(Effect.mapError(failure));
  const continueWith = (threadId: ThreadId, messageId: MessageId, text: string) =>
    Effect.gen(function* () {
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null || thread.archivedAt !== null) return "gone" as const;
      if (paused.has(threadId)) return "held" as const;
      if (thread.activeRunId !== null) return "busy" as const;
      yield* threads.sendToThread({
        commandId: CommandId.make(`viewcode:continue:${messageId}`),
        projectId: thread.projectId,
        threadId,
        messageId,
        text,
        attachments: [],
        mode: "auto",
        createdBy: "agent",
        creationSource: "server",
      });
      return "started" as const;
    }).pipe(gate.withPermit, Effect.mapError(failure));
  return AgentMessaging.of({
    listAgents: (caller) =>
      Effect.gen(function* () {
        const { thread: own, tree } = yield* treeOf(caller);
        return tree.map((thread): AgentSummary => ({
          id: thread.id,
          name: thread.title,
          parentId: thread.lineage.parentThreadId,
          relation:
            thread.id === caller
              ? "you"
              : thread.id === own.lineage.parentThreadId
                ? "parent"
                : thread.lineage.parentThreadId === caller
                  ? "child"
                  : thread.lineage.parentThreadId === own.lineage.parentThreadId
                    ? "sibling"
                    : "other",
          provider: thread.modelSelection.instanceId,
          model: thread.modelSelection.model,
          ...(selectedEffort(thread.modelSelection.options) === undefined
            ? {}
            : { effort: selectedEffort(thread.modelSelection.options)! }),
          status: paused.has(thread.id)
            ? "paused"
            : thread.status === "failed"
              ? "error"
              : thread.activeRunId !== null
                ? "running"
                : "idle",
          queuedMessages: queuedCount(thread.id),
        }));
      }).pipe(Effect.mapError(failure)),
    listModels: () =>
      providerRegistry.getProviders.pipe(
        Effect.map((providers) =>
          providers.map((provider) => ({
            providerId: provider.instanceId,
            name: provider.displayName ?? provider.driver,
            driver: provider.driver,
            usable:
              provider.enabled &&
              provider.disabledByAdmin !== true &&
              isProviderAvailable(provider),
            ...(provider.message === undefined ? {} : { note: provider.message }),
            models: provider.models.map((model) => ({
              id: model.slug,
              name: model.name,
              ...describeModelTuning(provider.driver, model.capabilities),
            })),
          })),
        ),
      ),
    spawnAgent,
    sendMessage,
    configureAgent: (caller, input) =>
      Effect.gen(function* () {
        const { target } = yield* resolve(caller, input.agent);
        const modelSelection = yield* selectModel(target, input);
        yield* threads.dispatch({
          type: "thread.model-selection.set",
          commandId: CommandId.make(`viewcode:configure:${yield* uuid}`),
          threadId: target.id,
          modelSelection,
        });
        return { agentId: target.id, appliesTo: "next-turn" as const };
      }).pipe(Effect.mapError(failure)),
    readTranscript: (caller, input) =>
      Effect.gen(function* () {
        const { target } = yield* resolve(caller, input.agent);
        const records = yield* threads.getThreadRecords(target.id, ["messages"]);
        return records.messages
          .slice(-Math.min(100, Math.max(1, input.lastMessages ?? 30)))
          .map((message) => `${message.role}: ${message.text}`)
          .join("\n\n")
          .slice(-24_000);
      }).pipe(Effect.mapError(failure)),
    searchHistory: (caller, input) =>
      Effect.gen(function* () {
        const { target } = yield* resolve(caller, input.agent ?? caller);
        const records = yield* threads.getThreadRecords(target.id, ["messages", "turnItems"]);
        return searchThreadHistory(
          {
            messages: records.messages.map((message) => ({
              ...message,
              createdAt: DateTime.formatIso(message.createdAt),
            })),
            activities: [
              ...(yield* activities.list(target.id)),
              ...records.turnItems
                .filter((item) => item.type !== "user_message" && item.type !== "assistant_message")
                .map((item) => ({
                  kind: item.type,
                  createdAt: DateTime.formatIso(item.updatedAt),
                  summary: item.title ?? item.type,
                  payload: item,
                })),
            ],
          },
          input.query,
          Math.min(50, input.limit ?? 10),
        );
      }).pipe(Effect.mapError(failure)),
    stop,
    resume,
    discard,
    continueAfterLimit: (threadId, messageId, reason) =>
      continueWith(
        threadId,
        messageId,
        reason === "usage" ? USAGE_RESET_CONTINUE_PROMPT : AGENT_CONTINUE_PROMPT,
      ).pipe(Effect.map((status) => (status === "held" ? "paused" : status))),
    wake: continueWith,
    setUsageResume: (threadId, state) =>
      Effect.gen(function* () {
        if (state === null) usage.delete(threadId);
        else usage.set(threadId, state);
        yield* publish;
      }),
    controlChanges: SubscriptionRef.changes(controls),
    start: () =>
      Effect.suspend(() => {
        if (started) return Effect.void;
        started = true;
        return Stream.runForEach(threads.streamDomainEvents, worker.enqueue).pipe(
          Effect.forkScoped,
          Effect.asVoid,
        );
      }),
    drain: worker.drain,
  });
});

export const layer = Layer.effect(AgentMessaging, make);
