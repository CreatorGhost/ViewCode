import { type HistoryMatch, searchThreadHistory } from "./searchHistory.ts";
import {
  AgentControlError,
  type AgentControlInput,
  type AgentControlResult,
  type AgentControlSnapshot,
  type AgentControlState,
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  ThreadId,
  type TurnId,
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
import * as SubscriptionRef from "effect/SubscriptionRef";

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
 * - a busy, paused or out-of-quota receiver queues it;
 * - when a message expects a reply and the receiver's turn ends without an
 *   explicit reply, that turn's final answer is routed back to the sender,
 *   which wakes the sender the same way.
 *
 * Each delivery is bound to the provider turn it started (the first turn to
 * run after its `thread.turn-start-requested` event), so a user prompt on the
 * same thread can never be mistaken for the answer.
 *
 * When the user stops an agent that belongs to a tree, it is paused: nothing
 * wakes it until the user resumes it (Resume, or typing a prompt into it) or
 * discards its held work.
 *
 * Chains of automatic deliveries are capped so two agents cannot keep each
 * other busy forever without the user.
 */

/**
 * Provider errors that retrying cannot fix until a quota or plan changes.
 * Providers report these only as text on the session, so the match stays
 * narrow; a context-length error is a different failure (see below).
 */
const LIMIT_ERROR_PATTERN =
  /usage[ _-]?limit|rate[ _-]?limit|quota|plan limit|MODEL_NOT_IN_PLAN|not (?:in|available on) (?:your )?plan|\bcredits?\b|insufficient (?:credit|balance|funds)|\b429\b|too many requests/i;
/** "Context window exceeded" and friends: the conversation is too long, the account is fine. */
const CONTEXT_LENGTH_PATTERN =
  /context[ _-]?(?:window|length)|maximum context|prompt is too long|too many tokens|max(?:imum)?[ _-]tokens/i;

export function isLimitError(message: string | null | undefined): message is string {
  return (
    typeof message === "string" &&
    LIMIT_ERROR_PATTERN.test(message) &&
    !CONTEXT_LENGTH_PATTERN.test(message)
  );
}

export const AGENT_MESSAGE_MAX_HOPS = 24;
const TRANSCRIPT_MAX_CHARS = 24_000;
/** The turn Resume sends to an agent whose turn the user stopped. */
export const AGENT_CONTINUE_PROMPT = "Continue where you left off.";

const hopLimitReason = `Stopped: this conversation between agents reached ${AGENT_MESSAGE_MAX_HOPS} automatic hops. Summarize the state for the user instead.`;

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
  readonly status: "running" | "idle" | "error" | "stopped" | "new" | "paused";
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
  readonly note?: string;
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

/** A turn this service started, from dispatch until the provider turn it became ends. */
interface OwnTurn {
  /** Null for Resume's "continue" turn, which answers nobody. */
  readonly delivery: Delivery | null;
  /** The user message that starts the turn. */
  readonly messageId: MessageId;
  /** Its `thread.turn-start-requested` event has been seen. */
  requested: boolean;
  /** The provider turn it runs as, bound when that turn starts. */
  turnId: TurnId | null;
  /** The receiver already answered with an explicit reply. */
  replied: boolean;
}

interface Pause {
  /** A turn was running when the user stopped the agent. */
  readonly interrupted: boolean;
  /** The stopped turn this service started; Resume continues it. */
  readonly held: OwnTurn | null;
}

type Job =
  | { readonly kind: "turn-ended"; readonly threadId: ThreadId; readonly turn: OwnTurn }
  | { readonly kind: "idle"; readonly threadId: ThreadId }
  | { readonly kind: "stopped"; readonly threadId: ThreadId; readonly interrupted: boolean }
  | { readonly kind: "user-prompt"; readonly threadId: ThreadId };

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
  /** Paused agents and queue lengths: the current value, then every change. */
  readonly controlChanges: Stream.Stream<AgentControlSnapshot>;
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

function isLive(status: OrchestrationSessionStatus): boolean {
  return status === "running" || status === "starting";
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
  // Agents whose last turn hit a usage/plan limit. Messages to them are
  // refused until a turn succeeds or viewcode_configure_agent moves them to
  // another model.
  const limited = new Map<string, string>();
  // The turn this service started on each thread, until it ends.
  const ownTurns = new Map<string, OwnTurn>();
  // Agents the user stopped; nothing wakes them until resumed.
  const paused = new Map<string, Pause>();
  // Threads whose session is running or starting, as of the last event seen.
  const active = new Set<string>();
  const pendingModels = new Map<string, ModelSelection>();
  const control = yield* SubscriptionRef.make<AgentControlSnapshot>([]);
  let controlKey = "";

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (reason: string) => Effect.fail(new AgentMessagingError({ reason }));

  const publishControl = Effect.suspend(() => {
    const ids = new Set<string>([...paused.keys(), ...queues.keys()]);
    const next: AgentControlState[] = [...ids].toSorted().map((id) => ({
      threadId: ThreadId.make(id),
      paused: paused.has(id),
      queued: queues.get(id)?.length ?? 0,
    }));
    const key = next.map((entry) => `${entry.threadId}:${entry.paused}:${entry.queued}`).join(",");
    if (key === controlKey) return Effect.void;
    controlKey = key;
    return SubscriptionRef.set(control, next);
  });

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

  /**
   * Starts a turn on `target`. The turn is registered before the first yield,
   * so a concurrent delivery sees the thread as taken and queues.
   */
  const startTurn = (
    target: OrchestrationThreadShell,
    text: string,
    delivery: Delivery | null,
    messageId: MessageId,
  ) => {
    const threadId = target.id;
    ownTurns.set(threadId, { delivery, messageId, requested: false, turnId: null, replied: false });
    const modelSelection = pendingModels.get(threadId);
    pendingModels.delete(threadId);
    return Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`server:agent-message:${messageId}`),
        threadId,
        message: { messageId, role: "user", text, attachments: [] },
        ...(modelSelection ? { modelSelection } : {}),
        runtimeMode: target.runtimeMode,
        interactionMode: "default",
        createdAt,
      });
    }).pipe(
      Effect.onError(() =>
        Effect.sync(() => {
          if (ownTurns.get(threadId)?.messageId === messageId) ownTurns.delete(threadId);
        }),
      ),
    );
  };

  const enqueue = (delivery: Delivery) => {
    const queue = queues.get(delivery.toThreadId) ?? [];
    queue.push(delivery);
    queues.set(delivery.toThreadId, queue);
  };

  /** Starts the delivery now when the receiver is free, otherwise queues it. */
  const deliver = Effect.fnUntraced(function* (delivery: Delivery) {
    const messageId = MessageId.make(yield* uuid);
    const threads = yield* shells;
    const target = threads.find((thread) => thread.id === delivery.toThreadId);
    if (!target) return yield* fail("The receiving agent no longer exists.");
    const to = delivery.toThreadId;
    if (
      paused.has(to) ||
      limited.has(to) ||
      isBusy(target) ||
      (queues.get(to)?.length ?? 0) > 0 ||
      ownTurns.has(to)
    ) {
      enqueue(delivery);
      yield* publishControl;
      return "queued" as const;
    }
    yield* startTurn(target, formatAgentMessage(delivery), delivery, messageId).pipe(
      Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })),
    );
    return "started" as const;
  });

  /** Starts the next queued message when the agent is free, unpaused and within quota. */
  const drainQueue = Effect.fnUntraced(function* (threadId: ThreadId) {
    const messageId = MessageId.make(yield* uuid);
    const threads = yield* shells;
    if (paused.has(threadId) || limited.has(threadId) || ownTurns.has(threadId)) return;
    const thread = threads.find((entry) => entry.id === threadId);
    if (!thread || isBusy(thread)) return;
    const queue = queues.get(threadId);
    const next = queue?.shift();
    if (queue && queue.length === 0) queues.delete(threadId);
    yield* publishControl;
    if (next) yield* startTurn(thread, formatAgentMessage(next), next, messageId);
  });

  const nextHop = (sender: ThreadId) => {
    const origin = ownTurns.get(sender)?.delivery;
    return origin ? { chainId: origin.chainId, hop: origin.hop + 1 } : null;
  };

  const pausedNote = (name: string) =>
    `${name} was stopped by the user. Your message is queued and will be delivered when the user resumes it; do not wait for it or resend.`;

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
      if (limitReason !== undefined) {
        return yield* fail(
          `${target.title} is out of quota and cannot take messages: ${limitReason} Do not retry. Use viewcode_configure_agent to move it to a model on another provider, viewcode_spawn_agent a new agent on another provider, or tell the user.`,
        );
      }
      const request = ownTurns.get(caller);
      const isReply =
        input.responseId !== undefined &&
        request?.delivery?.replyExpected === true &&
        request.delivery.messageId === input.responseId;
      if (input.responseId !== undefined && !isReply) {
        return yield* fail(
          `response_id "${input.responseId}" does not match a request you are answering.`,
        );
      }
      const hop = nextHop(caller) ?? { chainId: yield* uuid, hop: 0 };
      if (hop.hop >= AGENT_MESSAGE_MAX_HOPS) return yield* fail(hopLimitReason);
      if (isReply) request!.replied = true;
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
      return {
        messageId: delivery.messageId,
        delivery: status,
        ...(paused.has(target.id) ? { note: pausedNote(target.title) } : {}),
      };
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
      // A spawn is one more automatic hop, like a message.
      const hop = nextHop(caller) ?? { chainId: yield* uuid, hop: 0 };
      if (hop.hop >= AGENT_MESSAGE_MAX_HOPS) return yield* fail(hopLimitReason);
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
        status: paused.has(thread.id) ? "paused" : statusOf(thread),
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
      // Agent-started turns pass the model explicitly (the provider reactor
      // otherwise reuses the last model a turn asked for); the thread's own
      // model is what the composer offers for the user's next prompt.
      pendingModels.set(target.id, selection);
      yield* engine
        .dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`server:agent-configure:${yield* uuid}`),
          threadId: target.id,
          modelSelection: selection,
        })
        .pipe(Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })));
      const moved =
        selection.instanceId !== target.modelSelection.instanceId ||
        selection.model !== target.modelSelection.model;
      if (moved && limited.delete(target.id)) {
        // Out of quota → on a new model: the messages it held can run now.
        yield* drainQueue(target.id).pipe(
          Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })),
        );
      }
      return { agentId: target.id, appliesTo: "next-turn" as const };
    });

  /** Sends a reply for `turn` to its requester when one is due. */
  const routeReply = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    turn: OwnTurn,
    hitLimit: boolean,
  ) {
    const delivery = turn.delivery;
    if (!delivery) return;
    const wantsAnswer = delivery.replyExpected && !turn.replied;
    // A sender that expected no reply still needs to know its agent is out of quota.
    if (!wantsAnswer && !hitLimit) return;
    if (delivery.hop + 1 >= AGENT_MESSAGE_MAX_HOPS) return;
    const threads = yield* shells;
    const requester = threads.find((entry) => entry.id === delivery.fromThreadId);
    if (!requester) return;
    const lastError = thread.session?.lastError ?? null;
    // Only the final answer of the turn this delivery started.
    let answer: string | undefined;
    if (wantsAnswer && turn.turnId !== null) {
      const detail = yield* projections.getThreadDetailById(thread.id, { activityKinds: [] }).pipe(
        Effect.map(Option.getOrUndefined),
        Effect.orElseSucceed(() => undefined),
      );
      answer = (detail?.messages ?? []).findLast(
        (message) =>
          message.role === "assistant" &&
          message.turnId === turn.turnId &&
          message.text.trim().length > 0,
      )?.text;
    }
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
    yield* sendAutomatic(thread, requester, delivery, body);
  });

  const sendAutomatic = Effect.fnUntraced(function* (
    from: OrchestrationThreadShell,
    to: OrchestrationThreadShell,
    request: Delivery,
    body: string,
  ) {
    const reply: Delivery = {
      messageId: yield* uuid,
      chainId: request.chainId,
      hop: request.hop + 1,
      fromThreadId: from.id,
      fromName: from.title,
      toThreadId: to.id,
      body,
      replyExpected: false,
      inReplyTo: request.messageId,
    };
    const status = yield* deliver(reply).pipe(Effect.orElseSucceed(() => "queued" as const));
    yield* recordSent(reply, to.title, "message", status);
  });

  const updateLimit = (thread: OrchestrationThreadShell) => {
    const lastError = thread.session?.lastError ?? null;
    if (isLimitError(lastError)) limited.set(thread.id, lastError);
    else limited.delete(thread.id);
    return isLimitError(lastError);
  };

  /** Pauses an agent; a turn this service started that has not begun yet is held. */
  const pauseThread = (threadId: ThreadId, interrupted: boolean) => {
    const existing = paused.get(threadId);
    let held = existing?.held ?? null;
    const own = ownTurns.get(threadId);
    if (own && own.turnId === null && held === null) {
      ownTurns.delete(threadId);
      held = own;
    }
    paused.set(threadId, { interrupted: (existing?.interrupted ?? false) || interrupted, held });
  };

  const handleJob = Effect.fnUntraced(function* (job: Job) {
    const threads = yield* shells;
    const thread = threads.find((entry) => entry.id === job.threadId);
    if (!thread) return;
    switch (job.kind) {
      case "turn-ended": {
        const hitLimit = updateLimit(thread);
        // Stopped by the user (providers report an interrupted turn as
        // "interrupted" or as an ordinary "ready"): Resume continues it, and
        // its answer still goes to the requester.
        if (paused.has(job.threadId) && !hitLimit) {
          paused.set(job.threadId, { interrupted: true, held: job.turn });
          yield* publishControl;
          return;
        }
        yield* routeReply(thread, job.turn, hitLimit);
        yield* drainQueue(job.threadId);
        return;
      }
      case "idle": {
        if (ownTurns.has(job.threadId)) return;
        updateLimit(thread);
        yield* drainQueue(job.threadId);
        return;
      }
      case "stopped": {
        // A stop only pauses agents; a lone thread has nobody to hold messages from.
        if (agentTree(threads, job.threadId).length < 2) return;
        pauseThread(job.threadId, job.interrupted);
        yield* publishControl;
        return;
      }
      case "user-prompt": {
        // Typing into a stopped agent takes it over: it is resumed, and a
        // request it was answering when stopped is released.
        const pause = paused.get(job.threadId);
        if (!pause) return;
        paused.delete(job.threadId);
        yield* publishControl;
        const held = pause.held?.delivery;
        if (held?.replyExpected && !pause.held?.replied) {
          const requester = threads.find((entry) => entry.id === held.fromThreadId);
          if (requester && held.hop + 1 < AGENT_MESSAGE_MAX_HOPS) {
            yield* sendAutomatic(
              thread,
              requester,
              held,
              "(stopped by the user before answering; the user is now directing this agent)",
            );
          }
        }
        return;
      }
    }
  });

  const worker = yield* makeDrainableWorker((job: Job) =>
    handleJob(job).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("agent messaging failed to handle a thread event", {
          threadId: job.threadId,
          kind: job.kind,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  /**
   * Runs in event order, so turn binding and the running set are exact; the
   * work that reads projections goes to the worker, which keeps that order.
   */
  const processEvent = (event: OrchestrationEvent) =>
    Effect.suspend(() => {
      switch (event.type) {
        case "thread.turn-start-requested": {
          const own = ownTurns.get(event.payload.threadId);
          if (own && own.messageId === event.payload.messageId) {
            own.requested = true;
            return Effect.void;
          }
          return worker.enqueue({ kind: "user-prompt", threadId: event.payload.threadId });
        }
        case "thread.turn-interrupt-requested":
        case "thread.session-stop-requested": {
          const threadId = event.payload.threadId;
          return worker.enqueue({ kind: "stopped", threadId, interrupted: active.has(threadId) });
        }
        case "thread.session-set": {
          const { threadId, session } = event.payload;
          const live = isLive(session.status);
          if (live) active.add(threadId);
          else active.delete(threadId);
          const own = ownTurns.get(threadId);
          if (own?.requested) {
            if (own.turnId === null && session.status === "running" && session.activeTurnId) {
              own.turnId = session.activeTurnId;
              return Effect.void;
            }
            const ended =
              own.turnId !== null
                ? !live || (session.activeTurnId !== null && session.activeTurnId !== own.turnId)
                : session.status === "error" || session.status === "interrupted";
            if (ended) {
              ownTurns.delete(threadId);
              return worker.enqueue({ kind: "turn-ended", threadId, turn: own });
            }
          }
          return live ? Effect.void : worker.enqueue({ kind: "idle", threadId });
        }
        default:
          return Effect.void;
      }
    });

  const controlError = (cause: unknown) =>
    new AgentControlError({
      detail: cause instanceof Error ? cause.message : String(cause),
    });

  const scopeOf = Effect.fnUntraced(function* (input: AgentControlInput) {
    const threads = yield* shells;
    const self = threads.find((thread) => thread.id === input.threadId);
    if (!self) return yield* fail("That agent no longer exists.");
    return {
      threads,
      targets: input.scope === "tree" ? agentTree(threads, input.threadId) : [self],
    };
  });

  const stop: AgentMessagingShape["stop"] = (input) =>
    Effect.gen(function* () {
      const { threads, targets } = yield* scopeOf(input);
      const inTree = agentTree(threads, input.threadId).length > 1;
      const createdAt = yield* nowIso;
      const changed: ThreadId[] = [];
      for (const thread of targets) {
        const running = isBusy(thread) || active.has(thread.id);
        if (inTree) pauseThread(thread.id, running);
        if (!running) {
          if (inTree) changed.push(thread.id);
          continue;
        }
        changed.push(thread.id);
        const turnId =
          thread.session?.status === "running" ? thread.session.activeTurnId : undefined;
        yield* engine.dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(`server:agent-stop:${yield* uuid}`),
          threadId: thread.id,
          ...(turnId ? { turnId } : {}),
          createdAt,
        });
      }
      yield* publishControl;
      return { threadIds: changed };
    }).pipe(Effect.mapError(controlError));

  const resume: AgentMessagingShape["resume"] = (input) =>
    Effect.gen(function* () {
      const { targets } = yield* scopeOf(input);
      // Unpause the whole scope first so replies between its agents flow.
      const resumed = targets.flatMap((thread) => {
        const pause = paused.get(thread.id);
        if (!pause) return [];
        paused.delete(thread.id);
        return [{ thread, pause }];
      });
      yield* publishControl;
      for (const { thread, pause } of resumed) {
        const messageId = MessageId.make(yield* uuid);
        const fresh = (yield* shells).find((entry) => entry.id === thread.id);
        if (!fresh) continue;
        if (pause.interrupted && !isBusy(fresh) && !ownTurns.has(fresh.id)) {
          yield* startTurn(fresh, AGENT_CONTINUE_PROMPT, pause.held?.delivery ?? null, messageId);
          const own = ownTurns.get(fresh.id);
          if (own && pause.held?.replied) own.replied = true;
        } else {
          if (pause.held && !ownTurns.has(fresh.id)) {
            // Stopped before its turn began: deliver it again from the front of the queue.
            const delivery = pause.held.delivery;
            if (delivery) queues.set(fresh.id, [delivery, ...(queues.get(fresh.id) ?? [])]);
          }
          yield* drainQueue(fresh.id);
        }
      }
      for (const thread of targets) {
        if (!resumed.some((entry) => entry.thread.id === thread.id)) yield* drainQueue(thread.id);
      }
      return { threadIds: resumed.map((entry) => entry.thread.id) };
    }).pipe(Effect.mapError(controlError));

  const discard: AgentMessagingShape["discard"] = (input) =>
    Effect.gen(function* () {
      const { targets } = yield* scopeOf(input);
      const changed = targets
        .filter((thread) => {
          const had = paused.has(thread.id) || queues.has(thread.id);
          paused.delete(thread.id);
          queues.delete(thread.id);
          return had;
        })
        .map((thread) => thread.id);
      yield* publishControl;
      return { threadIds: changed };
    }).pipe(Effect.mapError(controlError));

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
    stop,
    resume,
    discard,
    controlChanges: SubscriptionRef.changes(control),
    start,
    drain: worker.drain,
  } satisfies AgentMessagingShape;
});

export const layer = Layer.effect(AgentMessaging, make);
