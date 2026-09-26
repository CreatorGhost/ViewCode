import { type HistoryMatch, searchThreadHistory } from "./searchHistory.ts";
import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import {
  AGENT_MESSAGE_SENT_ACTIVITY_KIND,
  type AgentMessageSentPayload,
  formatAgentMessage,
} from "@t3tools/shared/agentMessages";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";

/**
 * Agent-to-agent messaging between ViewCode agents.
 *
 * Every ViewCode agent is a thread; child agents carry `parentThreadId`. An
 * agent can see and message the agents in its own tree (its root and every
 * descendant). A message becomes a user turn on the receiving thread:
 *
 * - an idle receiver starts a turn immediately ("auto-wake");
 * - a busy receiver queues it until its current turn ends;
 * - when a message expects a reply and the receiver's turn ends without an
 *   explicit reply, its final answer is routed back to the sender, which
 *   wakes the sender the same way.
 *
 * Chains of automatic deliveries are capped so two agents cannot keep each
 * other busy forever without the user.
 */

/** Provider errors that retrying cannot fix until a quota or plan changes. */
const LIMIT_ERROR_PATTERN =
  /usage limit|rate[ _-]?limit|quota|exceed|\b429\b|MODEL_NOT_IN_PLAN|not (?:in|available on) (?:your )?plan|insufficient (?:credit|balance|funds)/i;

export function isLimitError(message: string | null | undefined): message is string {
  return typeof message === "string" && LIMIT_ERROR_PATTERN.test(message);
}

export const AGENT_MESSAGE_MAX_HOPS = 24;
const TRANSCRIPT_MAX_CHARS = 24_000;

export class AgentMessagingError extends Schema.TaggedError<AgentMessagingError>()(
  "AgentMessagingError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly relation: "you" | "parent" | "child" | "sibling" | "other";
  readonly provider: string;
  readonly model: string;
  readonly status: "running" | "idle" | "error" | "stopped" | "new";
  readonly queuedMessages: number;
}

export interface ProviderModels {
  readonly providerId: string;
  readonly name: string;
  readonly driver: string;
  readonly usable: boolean;
  readonly note?: string;
  readonly models: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}

export interface SendResult {
  readonly messageId: string;
  readonly delivery: "started" | "queued";
}

export interface SpawnResult extends SendResult {
  readonly agentId: string;
  readonly name: string;
}

interface Delivery {
  readonly messageId: string;
  readonly chainId: string;
  readonly hop: number;
  readonly fromThreadId: ThreadId;
  readonly fromName: string;
  readonly toThreadId: ThreadId;
  readonly body: string;
  readonly replyExpected: boolean;
  readonly inReplyTo: string | null;
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
      readonly replyExpected?: boolean | undefined;
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
      readonly model: string;
    },
  ) => Effect.Effect<
    { readonly agentId: string; readonly appliesTo: "next-turn" },
    AgentMessagingError
  >;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class AgentMessaging extends Context.Service<AgentMessaging, AgentMessagingShape>()(
  "t3/agents/AgentMessaging",
) {}

function statusOf(thread: OrchestrationThreadShell): AgentSummary["status"] {
  const session = thread.session;
  if (!session) return "new";
  if (session.status === "running" || session.status === "starting") return "running";
  if (session.status === "error") return "error";
  if (session.status === "stopped") return "stopped";
  return "idle";
}

function isBusy(thread: OrchestrationThreadShell): boolean {
  return (
    thread.session?.status === "running" ||
    thread.session?.status === "starting" ||
    thread.latestTurn?.state === "running"
  );
}

/** Root first, then every descendant of that root. */
export function agentTree(
  threads: ReadonlyArray<OrchestrationThreadShell>,
  caller: string,
): ReadonlyArray<OrchestrationThreadShell> {
  const byId = new Map(threads.map((thread) => [String(thread.id), thread]));
  let root = byId.get(caller);
  const seen = new Set<string>();
  while (
    root?.parentThreadId &&
    byId.has(String(root.parentThreadId)) &&
    !seen.has(String(root.id))
  ) {
    seen.add(String(root.id));
    root = byId.get(String(root.parentThreadId));
  }
  if (!root) return [];
  const tree: OrchestrationThreadShell[] = [root];
  for (let index = 0; index < tree.length; index += 1) {
    const current = String(tree[index]!.id);
    for (const thread of threads) {
      if (thread.parentThreadId && String(thread.parentThreadId) === current) tree.push(thread);
    }
  }
  return tree;
}

function relationOf(
  thread: OrchestrationThreadShell,
  caller: OrchestrationThreadShell,
): AgentSummary["relation"] {
  if (thread.id === caller.id) return "you";
  if (caller.parentThreadId && thread.id === caller.parentThreadId) return "parent";
  if (thread.parentThreadId && thread.parentThreadId === caller.id) return "child";
  if (thread.parentThreadId && thread.parentThreadId === caller.parentThreadId) return "sibling";
  return "other";
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const providerRegistry = yield* ProviderRegistry;
  const crypto = yield* Crypto.Crypto;

  const queues = new Map<string, Delivery[]>();
  // The request each receiver is currently answering (turn started by a
  // reply-expected message) and whether it already replied explicitly.
  // Agents whose last turn hit a usage/plan limit. Messages to them are
  // refused until a turn succeeds or viewcode_configure_agent moves them to another model.
  const limited = new Map<string, string>();
  const answering = new Map<string, { delivery: Delivery; replied: boolean; startedAt: string }>();
  // The delivery whose turn is running on a thread, for hop accounting.
  const runningDelivery = new Map<string, Delivery>();
  const pendingModels = new Map<string, ModelSelection>();

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (reason: string) => Effect.fail(new AgentMessagingError({ reason }));

  const shells = projections.getShellSnapshot().pipe(
    Effect.map((snapshot) => snapshot.threads),
    Effect.mapError(
      (cause) => new AgentMessagingError({ reason: `Could not read agents: ${String(cause)}` }),
    ),
  );

  const resolveCaller = Effect.fnUntraced(function* (caller: ThreadId) {
    const threads = yield* shells;
    const self = threads.find((thread) => thread.id === caller);
    if (!self) return yield* fail("This agent's thread was not found.");
    return { threads, self, tree: agentTree(threads, caller) };
  });

  const resolveTarget = (
    tree: ReadonlyArray<OrchestrationThreadShell>,
    reference: string,
  ): OrchestrationThreadShell | undefined => {
    const needle = reference.trim();
    return (
      tree.find((thread) => thread.id === needle) ??
      tree.find((thread) => thread.title === needle) ??
      tree.find((thread) => thread.title.toLowerCase() === needle.toLowerCase())
    );
  };

  const recordSent = (
    delivery: Delivery,
    toName: string,
    kind: "message" | "spawn",
    status: "started" | "queued",
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      const payload: AgentMessageSentPayload = {
        messageId: delivery.messageId,
        toThreadId: delivery.toThreadId,
        toName,
        body: delivery.body,
        replyExpected: delivery.replyExpected,
        inReplyTo: delivery.inReplyTo,
        kind,
        delivery: status,
      };
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:agent-message-sent:${yield* uuid}`),
        threadId: delivery.fromThreadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: AGENT_MESSAGE_SENT_ACTIVITY_KIND,
          summary: kind === "spawn" ? `Started ${toName}` : `Message to ${toName}`,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      });
    }).pipe(Effect.ignoreCause({ log: true }));

  const startTurn = Effect.fnUntraced(function* (delivery: Delivery) {
    const threads = yield* shells;
    const target = threads.find((thread) => thread.id === delivery.toThreadId);
    if (!target) return;
    const createdAt = yield* nowIso;
    const modelSelection = pendingModels.get(delivery.toThreadId);
    pendingModels.delete(delivery.toThreadId);
    runningDelivery.set(delivery.toThreadId, delivery);
    if (delivery.replyExpected) {
      answering.set(delivery.toThreadId, { delivery, replied: false, startedAt: createdAt });
    }
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(`server:agent-message:${delivery.messageId}`),
      threadId: delivery.toThreadId,
      message: {
        messageId: MessageId.make(yield* uuid),
        role: "user",
        text: formatAgentMessage(delivery),
        attachments: [],
      },
      ...(modelSelection ? { modelSelection } : {}),
      runtimeMode: target.runtimeMode,
      interactionMode: "default",
      createdAt,
    });
  });

  /** Starts the delivery now when the receiver is idle, otherwise queues it. */
  const deliver = Effect.fnUntraced(function* (delivery: Delivery) {
    const threads = yield* shells;
    const target = threads.find((thread) => thread.id === delivery.toThreadId);
    if (!target) return yield* fail("The receiving agent no longer exists.");
    const queue = queues.get(delivery.toThreadId) ?? [];
    if (isBusy(target) || queue.length > 0 || runningDelivery.has(delivery.toThreadId)) {
      queue.push(delivery);
      queues.set(delivery.toThreadId, queue);
      return "queued" as const;
    }
    yield* startTurn(delivery).pipe(
      Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })),
    );
    return "started" as const;
  });

  const nextHop = (sender: ThreadId) => {
    const origin = runningDelivery.get(sender);
    return origin ? { chainId: origin.chainId, hop: origin.hop + 1 } : null;
  };

  const sendMessage: AgentMessagingShape["sendMessage"] = (caller, input) =>
    Effect.gen(function* () {
      const { self, tree } = yield* resolveCaller(caller);
      const target = resolveTarget(tree, input.to);
      if (!target) {
        return yield* fail(
          `No agent "${input.to}" in this agent tree. Call viewcode_list_agents to see the agents you can message.`,
        );
      }
      if (target.id === self.id) return yield* fail("An agent cannot message itself.");
      const limitReason = limited.get(target.id);
      if (limitReason !== undefined && !pendingModels.has(target.id)) {
        return yield* fail(
          `${target.title} is out of quota and cannot take messages: ${limitReason} Do not retry. Use viewcode_configure_agent to move it to a model on another provider, viewcode_spawn_agent a new agent on another provider, or tell the user.`,
        );
      }
      const request = answering.get(caller);
      const isReply =
        input.responseId !== undefined &&
        request !== undefined &&
        request.delivery.messageId === input.responseId;
      if (input.responseId !== undefined && !isReply) {
        return yield* fail(
          `response_id "${input.responseId}" does not match a request you are answering.`,
        );
      }
      if (isReply) request!.replied = true;
      const hop = nextHop(caller) ?? { chainId: yield* uuid, hop: 0 };
      if (hop.hop >= AGENT_MESSAGE_MAX_HOPS) {
        return yield* fail(
          `Stopped: this conversation between agents reached ${AGENT_MESSAGE_MAX_HOPS} automatic hops. Summarize the state for the user instead.`,
        );
      }
      const delivery: Delivery = {
        messageId: yield* uuid,
        chainId: hop.chainId,
        hop: hop.hop,
        fromThreadId: self.id,
        fromName: self.title,
        toThreadId: target.id,
        body: input.message,
        replyExpected: !isReply && (input.replyExpected ?? false),
        inReplyTo: isReply ? input.responseId! : null,
      };
      const status = yield* deliver(delivery);
      yield* recordSent(delivery, target.title, "message", status);
      return { messageId: delivery.messageId, delivery: status };
    });

  const resolveModelSelection = (
    providerId: string | undefined,
    model: string | undefined,
    fallback: ModelSelection,
  ) =>
    Effect.gen(function* () {
      if (providerId === undefined && model === undefined) return fallback;
      const providers = yield* providerRegistry.getProviders;
      const instanceId = providerId ?? String(fallback.instanceId);
      const provider = providers.find((entry) => entry.instanceId === instanceId);
      if (!provider) {
        return yield* fail(
          `Unknown provider "${instanceId}". Call viewcode_list_models for valid ids.`,
        );
      }
      const slug =
        model === undefined
          ? (provider.models.find((entry) => entry.isDefault)?.slug ?? provider.models[0]?.slug)
          : provider.models.find(
              (entry) =>
                entry.slug === model ||
                entry.name.toLowerCase() === model.toLowerCase() ||
                entry.aliases?.includes(model),
            )?.slug;
      if (!slug) {
        return yield* fail(
          `Unknown model "${model}" for ${instanceId}. Call viewcode_list_models for valid ids.`,
        );
      }
      return {
        instanceId: ProviderInstanceId.make(instanceId),
        model: slug,
      } satisfies ModelSelection;
    });

  const spawnAgent: AgentMessagingShape["spawnAgent"] = (caller, input) =>
    Effect.gen(function* () {
      const { self } = yield* resolveCaller(caller);
      const modelSelection = yield* resolveModelSelection(
        input.providerId,
        input.model,
        self.modelSelection,
      );
      const childId = ThreadId.make(yield* uuid);
      const createdAt = yield* nowIso;
      yield* engine
        .dispatch({
          type: "thread.create",
          commandId: CommandId.make(`server:agent-spawn:${childId}`),
          threadId: childId,
          projectId: self.projectId,
          title: input.name.trim() || "Sub-agent",
          modelSelection,
          runtimeMode: self.runtimeMode,
          interactionMode: "default",
          branch: self.branch,
          worktreePath: self.worktreePath,
          parentThreadId: self.id,
          createdAt,
        })
        .pipe(Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })));
      const hop = nextHop(caller) ?? { chainId: yield* uuid, hop: 0 };
      const delivery: Delivery = {
        messageId: yield* uuid,
        chainId: hop.chainId,
        hop: hop.hop,
        fromThreadId: self.id,
        fromName: self.title,
        toThreadId: childId,
        body: input.prompt,
        replyExpected: input.replyExpected ?? true,
        inReplyTo: null,
      };
      const status = yield* deliver(delivery);
      yield* recordSent(delivery, input.name.trim() || "Sub-agent", "spawn", status);
      return {
        agentId: childId,
        name: input.name.trim() || "Sub-agent",
        messageId: delivery.messageId,
        delivery: status,
      };
    });

  const listAgents: AgentMessagingShape["listAgents"] = (caller) =>
    Effect.gen(function* () {
      const { self, tree } = yield* resolveCaller(caller);
      return tree.map((thread) => ({
        id: thread.id,
        name: thread.title,
        parentId: thread.parentThreadId ?? null,
        relation: relationOf(thread, self),
        provider: String(thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
        model: thread.modelSelection.model,
        status: statusOf(thread),
        queuedMessages: queues.get(thread.id)?.length ?? 0,
      }));
    });

  const listModels: AgentMessagingShape["listModels"] = () =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) =>
        // Unusable providers stay listed with the reason, so an agent asked
        // for "GPT" learns Codex needs attention instead of silently picking
        // another provider's copy of the model.
        providers
          .filter((provider) => provider.enabled && provider.status !== "disabled")
          .map((provider): ProviderModels => {
            const note = provider.message ?? provider.unavailableReason;
            return {
              providerId: String(provider.instanceId),
              name: provider.displayName ?? String(provider.driver),
              driver: String(provider.driver),
              usable: provider.status !== "error" && provider.availability !== "unavailable",
              ...(note ? { note } : {}),
              models: provider.models
                .filter((model) => model.isLegacy !== true)
                .map((model) => ({ id: model.slug, name: model.name })),
            };
          }),
      ),
    );

  const searchHistory: AgentMessagingShape["searchHistory"] = (caller, input) =>
    Effect.gen(function* () {
      const { tree } = yield* resolveCaller(caller);
      const target = input.agent === undefined ? caller : resolveTarget(tree, input.agent)?.id;
      if (target === undefined) {
        return yield* fail(`No agent "${input.agent}" in this agent tree.`);
      }
      const detail = yield* projections.getThreadDetailById(target).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      if (!detail) return yield* fail("That conversation could not be read.");
      return searchThreadHistory(detail, input.query, input.limit ?? 8);
    });

  const readTranscript: AgentMessagingShape["readTranscript"] = (caller, input) =>
    Effect.gen(function* () {
      const { tree } = yield* resolveCaller(caller);
      const target = resolveTarget(tree, input.agent);
      if (!target) return yield* fail(`No agent "${input.agent}" in this agent tree.`);
      const detail = yield* projections.getThreadDetailById(target.id, { activityKinds: [] }).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })),
      );
      if (!detail) return yield* fail("That agent's transcript is not available.");
      const messages = detail.messages
        .filter((message) => message.role !== "system")
        .slice(-(input.lastMessages ?? 12));
      const text = messages
        .map((message) => `<${message.role}>\n${message.text.trim()}\n</${message.role}>`)
        .join("\n");
      return text.length > TRANSCRIPT_MAX_CHARS ? `…${text.slice(-TRANSCRIPT_MAX_CHARS)}` : text;
    });

  const configureAgent: AgentMessagingShape["configureAgent"] = (caller, input) =>
    Effect.gen(function* () {
      const { tree } = yield* resolveCaller(caller);
      const target = resolveTarget(tree, input.agent);
      if (!target) return yield* fail(`No agent "${input.agent}" in this agent tree.`);
      const selection = yield* resolveModelSelection(
        input.providerId,
        input.model,
        target.modelSelection,
      );
      pendingModels.set(target.id, selection);
      return { agentId: target.id, appliesTo: "next-turn" as const };
    });

  /** A receiver's turn ended: route an unanswered reply, then deliver the next queued message. */
  const onTurnEnded = Effect.fnUntraced(function* (threadId: ThreadId) {
    const threads = yield* shells;
    const thread = threads.find((entry) => entry.id === threadId);
    if (!thread || isBusy(thread)) return;
    const running = runningDelivery.get(threadId);
    runningDelivery.delete(threadId);
    const request = answering.get(threadId);
    answering.delete(threadId);
    const lastError = thread.session?.lastError ?? null;
    const hitLimit = isLimitError(lastError);
    if (hitLimit) limited.set(threadId, lastError);
    else limited.delete(threadId);
    // A sender that expected no reply still needs to know its agent is out of quota.
    const notify = request && !request.replied ? request.delivery : hitLimit ? running : undefined;
    if (notify) {
      const detail = yield* projections.getThreadDetailById(threadId, { activityKinds: [] }).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      // Only this turn's answer: an older reply would read as the answer to
      // the new request. A turn that failed reports its error instead.
      // Without a reply request we don't know when the turn began, so send no answer text.
      const startedAt = request?.startedAt;
      const answer =
        startedAt === undefined
          ? undefined
          : [...(detail?.messages ?? [])]
              .reverse()
              .find(
                (message) =>
                  message.role === "assistant" &&
                  message.createdAt >= startedAt &&
                  message.text.trim().length > 0,
              )?.text;
      const requester = threads.find((entry) => entry.id === notify.fromThreadId);
      if (requester && notify.hop + 1 < AGENT_MESSAGE_MAX_HOPS) {
        const limitNotice = hitLimit
          ? `[Usage limit reached: ${lastError} This agent stops here. Do not message it again or wait for it; use viewcode_configure_agent to move it to a model on another provider, or finish without it.]`
          : null;
        const body =
          limitNotice !== null
            ? [answer, limitNotice].filter(Boolean).join("\n\n")
            : (answer ??
              (lastError
                ? `(failed without an answer: ${lastError})`
                : "(finished without a written answer)"));
        const reply: Delivery = {
          messageId: yield* uuid,
          chainId: notify.chainId,
          hop: notify.hop + 1,
          fromThreadId: threadId,
          fromName: thread.title,
          toThreadId: requester.id,
          body,
          replyExpected: false,
          inReplyTo: notify.messageId,
        };
        const status = yield* deliver(reply).pipe(Effect.orElseSucceed(() => "queued" as const));
        yield* recordSent(reply, requester.title, "message", status);
      }
    }
    // Queued messages wait: waking an agent that is out of quota only fails again.
    if (hitLimit) return;
    const queue = queues.get(threadId);
    const next = queue?.shift();
    if (queue && queue.length === 0) queues.delete(threadId);
    if (next) yield* startTurn(next);
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    onTurnEnded(threadId).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("agent messaging failed to handle a finished turn", {
          threadId,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.session-set" &&
    event.payload.session.status !== "running" &&
    event.payload.session.status !== "starting"
      ? worker.enqueue(event.payload.threadId)
      : Effect.void;

  const start: AgentMessagingShape["start"] = Effect.fn("AgentMessaging.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return {
    listAgents,
    listModels,
    spawnAgent,
    sendMessage,
    readTranscript,
    searchHistory,
    configureAgent,
    start,
    drain: worker.drain,
  } satisfies AgentMessagingShape;
});

export const layer = Layer.effect(AgentMessaging, make);
