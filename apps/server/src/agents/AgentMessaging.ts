import { type HistoryMatch, searchThreadHistory } from "./searchHistory.ts";
import {
  applyModelTuning,
  describeModelTuning,
  selectedEffort,
  withoutEffort,
  type ModelTuning,
} from "./modelOptions.ts";
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
  type OrchestrationSession,
  type OrchestrationSessionStatus,
  type OrchestrationThreadShell,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import {
  AGENT_MESSAGE_SENT_ACTIVITY_KIND,
  type AgentMessageSentPayload,
  formatAgentMessage,
} from "@t3tools/shared/agentMessages";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { formatResumeAt, formatResumeTime, isLimitError } from "@t3tools/shared/usageLimit";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { forkParked } from "../serverActivation.ts";
import {
  USAGE_RESET_MARGIN_MS,
  mergeRateLimitSignal,
  pickResetTime,
  type RateLimitSignal,
  freshUsageWindows,
  limitKindOf,
  selectSpentWindowReset,
  SPENT_WINDOW_PERCENT,
} from "./usageResetTime.ts";
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
 * Each delivery is bound to the provider turn returned by its send request,
 * so an overlapping user prompt cannot be mistaken for the answer.
 *
 * When the user stops an agent that belongs to a tree, it is paused: nothing
 * wakes it until the user resumes it (Resume, or typing a prompt into it) or
 * discards its held work.
 *
 * Chains of automatic deliveries are capped so two agents cannot keep each
 * other busy forever without the user.
 */

export { isLimitError };

/** A reset further away than this is more likely a misread than a limit. */
const MAX_RESET_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;
/** With no reset time, an out-of-usage agent is tried again this long after the failure. */
export const UNKNOWN_RESET_RETRY_MS = 10 * 60_000;

export const AGENT_MESSAGE_MAX_HOPS = 24;
const TRANSCRIPT_MAX_CHARS = 24_000;
/** The turn Resume sends to an agent whose turn the user stopped. */
export const AGENT_CONTINUE_PROMPT = "Continue where you left off.";
/** The turn that picks a thread back up after its usage limit reset. */
export const USAGE_RESET_CONTINUE_PROMPT =
  "The usage limit has reset. Continue exactly where you left off and finish the task.";

const hopLimitReason = `Stopped: this conversation between agents reached ${AGENT_MESSAGE_MAX_HOPS} automatic hops. Summarize the state for the user instead.`;

export class AgentMessagingError extends Schema.TaggedError<AgentMessagingError>()(
  "AgentMessagingError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

const SPAWN_DEFAULT_EFFORT = "high";

export interface AgentSummary {
  readonly id: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly relation: "you" | "parent" | "child" | "sibling" | "other";
  readonly provider: string;
  readonly model: string;
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

const decodeTurnStartReceipt = Schema.decodeUnknownOption(
  Schema.Struct({
    requestId: Schema.String,
    detail: Schema.optional(Schema.String),
  }),
);

/**
 * An agent whose last turn hit a usage limit. It blocks deliveries until
 * `retryAfter`; after that the next delivery is the probe, and a turn that
 * succeeds anywhere on the same provider instance clears every mark on it.
 */
interface LimitMark {
  readonly reason: string;
  readonly instanceId: string;
  /** Epoch ms the provider says the limit resets; null when nothing said. */
  resetsAt: number | null;
  /** Nothing is delivered before this: the reset plus a minute, or ten minutes on when unknown. */
  retryAfter: number;
  /** When the limit was last seen to hold: the failure, or a usage reading that still showed it. */
  lastCheckedAt: number;
  /** The timer has released the queue at `retryAfter`; the mark stays as status until a turn succeeds. */
  released: boolean;
}

/** A turn this service started, from dispatch until the provider turn it became ends. */
interface OwnTurn {
  /** Null when continuing a user-started turn with no requester. */
  readonly delivery: Delivery | null;
  /** The user message that starts the turn. */
  readonly messageId: MessageId;
  readonly text: string;
  finishing: boolean;
  discarded: boolean;
  /** Lifecycle events can arrive before the send acceptance receipt. */
  observedTurnId: TurnId | null;
  readonly ended: Map<TurnId, OrchestrationSession>;
  /** The provider turn returned by the matching send acceptance receipt. */
  turnId: TurnId | null;
  /** The receiver already answered with an explicit reply. */
  replied: boolean;
  /** The latest session state seen since this turn was requested. */
  lastSession: OrchestrationSession | null;
  /** The user stopped the agent before this turn bound; we interrupted it when it did. */
  stopIssued: boolean;
}

interface Pause {
  action: "hold" | "resume" | "discard";
  /** A turn was running when the user stopped the agent. */
  readonly interrupted: boolean;
  /** The stopped turn this service started; Resume continues it. */
  readonly held: OwnTurn | null;
  /** The session state the held turn ended with. */
  readonly heldSession?: OrchestrationSession | undefined;
}

type Job =
  | {
      readonly kind: "turn-ended";
      readonly threadId: ThreadId;
      readonly turn: OwnTurn;
      readonly session: OrchestrationSession;
      readonly signal: RateLimitSignal | undefined;
    }
  | {
      readonly kind: "idle";
      readonly threadId: ThreadId;
      readonly signal: RateLimitSignal | undefined;
    }
  | { readonly kind: "hold-turn"; readonly threadId: ThreadId; readonly turn: OwnTurn }
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
  // Agents whose last turn hit a usage/plan limit. Messages to them queue
  // until the mark's retryAfter, then the next one is delivered as the probe.
  const limited = new Map<string, LimitMark>();
  // The provider's own rate-limit signal seen during the running turn, by thread.
  const signals = new Map<string, RateLimitSignal>();
  const usageStates = new Map<string, { readonly resumeAt?: string }>();
  const limitChanged = yield* Queue.sliding<void>(1);
  const now = Clock.currentTimeMillis;
  /** Whether deliveries to the agent are held back right now. */
  const blocks = (id: string, nowMs: number) => {
    const mark = limited.get(id);
    return mark !== undefined && nowMs < mark.retryAfter;
  };
  /** The mark while it still describes the agent; a known reset that has passed no longer does. */
  const activeMark = (id: string, nowMs: number) => {
    const mark = limited.get(id);
    return mark !== undefined && (mark.resetsAt === null || nowMs < mark.retryAfter)
      ? mark
      : undefined;
  };
  const isoOf = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const clockText = (ms: number, nowMs: number) => formatResumeTime(ms, nowMs);
  const clockAt = (ms: number, nowMs: number) => formatResumeAt(ms, nowMs);
  /** e.g. "out of usage until 9:00 AM (last checked 7:42 AM)". */
  const describeMark = (mark: LimitMark, nowMs: number) =>
    mark.resetsAt !== null
      ? `out of usage until ${clockText(mark.resetsAt, nowMs)} (last checked ${clockText(mark.lastCheckedAt, nowMs)})`
      : `out of usage; last checked ${clockText(mark.lastCheckedAt, nowMs)}, retrying after ${clockText(mark.retryAfter, nowMs)}`;
  // The turn this service started on each thread, until it ends.
  const ownTurns = new Map<string, OwnTurn>();
  // Agents the user stopped; nothing wakes them until resumed.
  const paused = new Map<string, Pause>();
  // Threads whose session is running or starting, as of the last event seen.
  const active = new Set<string>();
  const pendingModels = new Map<string, ModelSelection>();
  const ownStopCommands = new Set<CommandId>();
  const control = yield* SubscriptionRef.make<AgentControlSnapshot>([]);
  let controlKey = "";

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));
  const fail = (reason: string) => Effect.fail(new AgentMessagingError({ reason }));

  const publishControl = Effect.suspend(() => {
    const ids = new Set<string>([...paused.keys(), ...queues.keys(), ...usageStates.keys()]);
    const next: AgentControlState[] = [...ids].toSorted().map((id) => {
      const usage = usageStates.get(id);
      return {
        threadId: ThreadId.make(id),
        paused: paused.has(id),
        queued: queues.get(id)?.length ?? 0,
        ...(usage ? { usageResume: usage } : {}),
      };
    });
    const key = next
      .map(
        (entry) =>
          `${entry.threadId}:${entry.paused}:${entry.queued}:${entry.usageResume ? (entry.usageResume.resumeAt ?? "-") : "x"}`,
      )
      .join(",");
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
    task?: string,
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
        ...(task ? { task } : {}),
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
    ownTurns.set(threadId, {
      delivery,
      messageId,
      text,
      finishing: false,
      discarded: false,
      observedTurnId: null,
      ended: new Map(),
      turnId: null,
      replied: false,
      lastSession: null,
      stopIssued: false,
    });
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
    if (target.archivedAt !== null) {
      return yield* fail(`${target.title} is archived; the user has to unarchive it first.`);
    }
    const to = delivery.toThreadId;
    const nowMs = yield* now;
    if (
      paused.has(to) ||
      blocks(to, nowMs) ||
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
    if (paused.has(threadId) || blocks(threadId, yield* now) || ownTurns.has(threadId)) return;
    const thread = threads.find((entry) => entry.id === threadId);
    // An archived agent keeps its queue; nothing runs in it until it is unarchived.
    if (!thread || thread.archivedAt !== null || isBusy(thread)) return;
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

  /** What the sender is told when the receiver's provider is out of usage. */
  const limitNote = (
    title: string,
    id: string,
    delivery: "started" | "queued",
    nowMs: number,
  ): string | null => {
    const mark = activeMark(id, nowMs);
    if (!mark) return null;
    const move = "or use viewcode_configure_agent to move it to another provider";
    if (delivery === "started") {
      return `${title} hit its usage limit earlier (${describeMark(mark, nowMs)}). This message was delivered as a check; you will be told if the limit still applies.`;
    }
    if (nowMs >= mark.retryAfter) {
      return `${title} hit its usage limit earlier (${describeMark(mark, nowMs)}). Your message is queued behind its current work.`;
    }
    return `${title} is ${describeMark(mark, nowMs)}. Your message is queued and will be delivered automatically ${clockAt(mark.retryAfter, nowMs)}; ${move}.`;
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
      const notes = [
        paused.has(target.id) ? pausedNote(target.title) : null,
        limitNote(target.title, target.id, status, yield* now),
      ].filter((note) => note !== null);
      return {
        messageId: delivery.messageId,
        delivery: status,
        ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
      };
    });

  const resolveModelSelection = (
    providerId: string | undefined,
    model: string | undefined,
    fallback: ModelSelection,
    tuning: { readonly effort?: string | undefined; readonly fastMode?: boolean | undefined } = {},
  ) =>
    Effect.gen(function* () {
      const tuned = tuning.effort !== undefined || tuning.fastMode !== undefined;
      if (providerId === undefined && model === undefined && !tuned) return fallback;
      const providers = yield* providerRegistry.getProviders;
      const instanceId = providerId ?? String(fallback.instanceId);
      const provider = providers.find((entry) => entry.instanceId === instanceId);
      if (!provider) {
        return yield* fail(
          `Unknown provider "${instanceId}". Call viewcode_list_models for valid ids.`,
        );
      }
      const keepModel = providerId === undefined && model === undefined;
      const slug = keepModel
        ? fallback.model
        : model === undefined
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
      const unchanged = String(fallback.instanceId) === instanceId && fallback.model === slug;
      if (!tuned) {
        return unchanged
          ? fallback
          : ({
              instanceId: ProviderInstanceId.make(instanceId),
              model: slug,
            } satisfies ModelSelection);
      }
      const applied = applyModelTuning({
        driver: String(provider.driver),
        model: slug,
        capabilities: provider.models.find((entry) => entry.slug === slug)?.capabilities,
        existing: unchanged ? fallback.options : undefined,
        effort: tuning.effort,
        fastMode: tuning.fastMode,
      });
      if ("error" in applied) return yield* fail(applied.error);
      return {
        instanceId: ProviderInstanceId.make(instanceId),
        model: slug,
        ...(applied.options ? { options: applied.options } : {}),
      } satisfies ModelSelection;
    });

  const spawnAgent: AgentMessagingShape["spawnAgent"] = (caller, input) =>
    Effect.gen(function* () {
      const { self } = yield* resolveCaller(caller);
      // A spawn is one more automatic hop, like a message.
      const hop = nextHop(caller) ?? { chainId: yield* uuid, hop: 0 };
      if (hop.hop >= AGENT_MESSAGE_MAX_HOPS) return yield* fail(hopLimitReason);
      // Children run at High unless the caller asks for a level; a model
      // without a High effort keeps its own default.
      const modelSelection =
        input.effort !== undefined
          ? yield* resolveModelSelection(input.providerId, input.model, self.modelSelection, {
              effort: input.effort,
              fastMode: input.fastMode,
            })
          : yield* resolveModelSelection(input.providerId, input.model, self.modelSelection, {
              effort: SPAWN_DEFAULT_EFFORT,
              fastMode: input.fastMode,
            }).pipe(
              Effect.catch(() =>
                resolveModelSelection(
                  input.providerId,
                  input.model,
                  withoutEffort(self.modelSelection),
                  { fastMode: input.fastMode },
                ),
              ),
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
      yield* recordSent(
        delivery,
        input.name.trim() || "Sub-agent",
        "spawn",
        status,
        input.task?.trim() || undefined,
      );
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
      const nowMs = yield* now;
      return tree.map((thread): AgentSummary => {
        const mark = activeMark(thread.id, nowMs);
        const effort = selectedEffort(thread.modelSelection.options);
        return {
          id: thread.id,
          name: thread.title,
          parentId: thread.parentThreadId ?? null,
          relation: relationOf(thread, self),
          provider: String(thread.session?.providerInstanceId ?? thread.modelSelection.instanceId),
          model: thread.modelSelection.model,
          ...(effort !== undefined ? { effort } : {}),
          status: paused.has(thread.id) ? "paused" : statusOf(thread),
          queuedMessages: queues.get(thread.id)?.length ?? 0,
          ...(mark
            ? {
                outOfUsage: {
                  summary: describeMark(mark, nowMs),
                  ...(mark.resetsAt !== null ? { resetsAt: isoOf(mark.resetsAt) } : {}),
                  retryAfter: isoOf(mark.retryAfter),
                  lastCheckedAt: isoOf(mark.lastCheckedAt),
                },
              }
            : {}),
        };
      });
    });

  const listModels: AgentMessagingShape["listModels"] = () =>
    Effect.all([providerRegistry.getProviders, now]).pipe(
      Effect.map(([providers, nowMs]) =>
        // Unusable providers stay listed with the reason, so an agent asked
        // for "GPT" learns Codex needs attention instead of silently picking
        // another provider's copy of the model.
        providers
          .filter((provider) => provider.enabled && provider.status !== "disabled")
          .map((provider): ProviderModels => {
            const note = provider.message ?? provider.unavailableReason;
            const usage = provider.usageLimits;
            const reading =
              usage && usage.unavailable === undefined && usage.windows.length > 0
                ? {
                    exhausted: usage.windows.some(
                      (window) =>
                        window.usedPercent >= SPENT_WINDOW_PERCENT &&
                        (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
                    ),
                    resetsAt: selectSpentWindowReset(usage.windows, nowMs),
                    checkedAt: usage.checkedAt,
                  }
                : undefined;
            return {
              providerId: String(provider.instanceId),
              name: provider.displayName ?? String(provider.driver),
              driver: String(provider.driver),
              usable: provider.status !== "error" && provider.availability !== "unavailable",
              ...(note ? { note } : {}),
              ...(reading
                ? {
                    usage: {
                      exhausted: reading.exhausted,
                      ...(reading.exhausted && reading.resetsAt !== null
                        ? { resetsAt: isoOf(reading.resetsAt) }
                        : {}),
                      checkedAt: reading.checkedAt,
                    },
                  }
                : {}),
              models: provider.models
                .filter((model) => model.isLegacy !== true)
                .map((model) => ({
                  id: model.slug,
                  name: model.name,
                  ...describeModelTuning(String(provider.driver), model.capabilities),
                })),
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
        { effort: input.effort, fastMode: input.fastMode },
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
    if (!delivery || turn.discarded) return;
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
    const mark = hitLimit ? limited.get(thread.id) : undefined;
    const nowMs = yield* now;
    const label = mark ? yield* providerLabel(mark.instanceId) : "provider";
    const move =
      "To keep going now, use viewcode_configure_agent to move it to a model on another provider.";
    const limitNotice = hitLimit
      ? mark?.resetsAt != null
        ? `[Usage limit reached: ${lastError} ${thread.title} is out of ${label} usage until ${clockText(mark.resetsAt, nowMs)}. ViewCode will tell you when it is back; messages you send it before then are queued and delivered automatically ${clockAt(mark.retryAfter, nowMs)}. ${move}]`
        : `[Usage limit reached: ${lastError} ${thread.title} is out of ${label} usage and its reset time is unknown; retry after ${clockText(mark?.retryAfter ?? nowMs, nowMs)}. Messages you send it are queued and delivered automatically then, and ViewCode will tell you when it is back. ${move}]`
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

  const instanceOf = (thread: OrchestrationThreadShell) =>
    String(thread.session?.providerInstanceId ?? thread.modelSelection.instanceId);

  /** The instance's usage windows when the reading is recent enough to trust. */
  const usageWindows = (instanceId: string, nowMs: number) =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) =>
        freshUsageWindows(
          providers.find((entry) => String(entry.instanceId) === instanceId)?.usageLimits,
          nowMs,
        ),
      ),
      Effect.orElseSucceed(() => []),
    );

  const wakeLimits = Queue.offer(limitChanged, undefined).pipe(Effect.asVoid);

  /**
   * Marks or unmarks the agent from how its turn ended. A limit failure is
   * always a fresh observation of the limit; an idle event without a new turn
   * keeps the mark it has, so re-reading the same error does not push its
   * retry time back.
   */
  const updateLimit = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    signal: RateLimitSignal | undefined,
    fresh: boolean,
  ) {
    const lastError = thread.session?.lastError ?? null;
    const nowMs = yield* now;
    // A transient throttle is not out of usage: no mark (UsageResume retries it).
    if (lastError === null || limitKindOf(lastError, nowMs, signal)?.kind !== "usage") {
      limited.delete(thread.id);
      return false;
    }
    if (!fresh && limited.get(thread.id)?.reason === lastError) return true;
    const instanceId = instanceOf(thread);
    const resetsAt = pickResetTime({
      recorded: signal,
      text: lastError,
      windows: yield* usageWindows(instanceId, nowMs),
      nowMs,
    });
    const known = resetsAt !== null && resetsAt - nowMs <= MAX_RESET_HORIZON_MS;
    limited.set(thread.id, {
      reason: lastError,
      instanceId,
      resetsAt: known ? resetsAt : null,
      retryAfter: known
        ? Math.max(resetsAt + USAGE_RESET_MARGIN_MS, nowMs + 5_000)
        : nowMs + UNKNOWN_RESET_RETRY_MS,
      lastCheckedAt: nowMs,
      released: false,
    });
    yield* wakeLimits;
    return true;
  });

  const providerLabel = (instanceId: string) =>
    providerRegistry.getProviders.pipe(
      Effect.map((providers) => {
        const provider = providers.find((entry) => String(entry.instanceId) === instanceId);
        return provider?.displayName ?? String(provider?.driver ?? instanceId);
      }),
      Effect.orElseSucceed(() => instanceId),
    );

  /**
   * An agent's limit no longer holds. Messages already queued for it were sent
   * on purpose, so they go out now. With none queued, a child is not continued
   * on its own (its lead may have moved the work): the lead is told instead,
   * which starts a turn for it like any other agent message.
   */
  const releaseMark = Effect.fnUntraced(function* (id: string, mark: LimitMark) {
    const threadId = ThreadId.make(id);
    const hadQueue = (queues.get(id)?.length ?? 0) > 0;
    yield* drainQueue(threadId);
    if (hadQueue) return;
    const threads = yield* shells;
    const child = threads.find((entry) => entry.id === threadId);
    if (!child?.parentThreadId || child.archivedAt !== null || isBusy(child) || ownTurns.has(id))
      return;
    const lead = threads.find((entry) => entry.id === child.parentThreadId);
    if (!lead || lead.archivedAt !== null) return;
    const nowMs = yield* now;
    const label = yield* providerLabel(mark.instanceId);
    const reset = mark.resetsAt !== null ? ` (reset ${clockText(mark.resetsAt, nowMs)})` : "";
    const request: Delivery = {
      messageId: yield* uuid,
      chainId: yield* uuid,
      hop: 0,
      fromThreadId: lead.id,
      fromName: lead.title,
      toThreadId: child.id,
      body: "",
      replyExpected: false,
      inReplyTo: null,
    };
    yield* sendAutomatic(
      child,
      lead,
      request,
      `${label} usage is back${reset}. ${child.title} stopped mid-task on the limit and is available again. Resume it with viewcode_send_message (for example "continue where you left off"), or leave it if you have moved the work.`,
    );
  });

  const releaseSafely = (id: string, mark: LimitMark) =>
    releaseMark(id, mark).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("agent messaging failed to release an agent after its limit cleared", {
          threadId: id,
          cause: Cause.pretty(cause),
        }),
      ),
    );

  /** A turn worked on this provider instance, so its limit is not holding anyone: release them all. */
  const clearInstance = Effect.fnUntraced(function* (instanceId: string) {
    const cleared = [...limited].filter(([, mark]) => mark.instanceId === instanceId);
    if (cleared.length === 0) return;
    for (const [id] of cleared) limited.delete(id);
    yield* wakeLimits;
    for (const [id, mark] of cleared) yield* releaseSafely(id, mark);
  });

  /**
   * Sleeps to the earliest retry time. A known reset that has passed drops the
   * mark; an unknown one is released so the oldest queued message goes out as
   * the probe. Woken whenever the marks change; there is no polling.
   */
  const limitTimer = Effect.gen(function* () {
    while (true) {
      const nowMs = yield* now;
      let next: number | null = null;
      for (const [id, mark] of [...limited]) {
        if (mark.released) continue;
        if (mark.retryAfter <= nowMs) {
          if (mark.resetsAt !== null) {
            limited.delete(id);
            yield* releaseSafely(id, mark);
          } else {
            // Unknown reset: the oldest queued message goes out as the probe.
            mark.released = true;
            yield* drainQueue(ThreadId.make(id)).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("agent messaging failed to release a queue at its retry time", {
                  threadId: id,
                  cause: Cause.pretty(cause),
                }),
              ),
            );
          }
        } else if (next === null || mark.retryAfter < next) {
          next = mark.retryAfter;
        }
      }
      if (next === null) {
        yield* Queue.take(limitChanged);
      } else {
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - one sleep to the earliest retry, cut short when the marks change
        yield* Effect.raceFirst(
          Queue.take(limitChanged),
          Effect.sleep(Duration.millis(next - nowMs)),
        );
      }
    }
  });

  /** A fresh usage reading for a provider instance: clears its marks, or refines the reset time. */
  const onProvidersChanged = Effect.fnUntraced(function* (
    providers: ReadonlyArray<ServerProvider>,
  ) {
    if (limited.size === 0) return;
    const nowMs = yield* now;
    for (const provider of providers) {
      const usage = provider.usageLimits;
      if (!usage || usage.unavailable !== undefined || usage.refreshError !== undefined) continue;
      if (usage.windows.length === 0) continue;
      const instanceId = String(provider.instanceId);
      if (![...limited.values()].some((mark) => mark.instanceId === instanceId)) continue;
      const checkedAt = Date.parse(usage.checkedAt);
      const spent = usage.windows.some(
        (window) =>
          window.usedPercent >= SPENT_WINDOW_PERCENT &&
          (window.resetsAt === undefined || Date.parse(window.resetsAt) > nowMs),
      );
      if (!spent) {
        yield* clearInstance(instanceId);
        continue;
      }
      const reset = selectSpentWindowReset(usage.windows, nowMs);
      for (const mark of limited.values()) {
        if (mark.instanceId !== instanceId) continue;
        if (Number.isFinite(checkedAt))
          mark.lastCheckedAt = Math.max(mark.lastCheckedAt, checkedAt);
        if (mark.resetsAt === null && reset !== null && reset - nowMs <= MAX_RESET_HORIZON_MS) {
          mark.resetsAt = reset;
          mark.retryAfter = reset + USAGE_RESET_MARGIN_MS;
          mark.released = false;
        }
      }
      yield* wakeLimits;
    }
  });

  /** Keep the in-flight delivery until its terminal event and acceptance agree. */
  const pauseThread = (threadId: ThreadId, interrupted: boolean) => {
    const existing = paused.get(threadId);
    paused.set(threadId, {
      interrupted: (existing?.interrupted ?? false) || interrupted,
      held: existing?.held ?? null,
      action: "hold",
    });
  };

  const finishPause = Effect.fnUntraced(function* (thread: OrchestrationThreadShell) {
    const pause = paused.get(thread.id);
    if (!pause || pause.action === "hold" || ownTurns.has(thread.id) || isBusy(thread)) return;
    if (pause.action === "resume" && pause.interrupted) {
      const messageId = MessageId.make(yield* uuid);
      // Stop/Discard may have replaced the intent while prerequisites were awaited.
      if (paused.get(thread.id) !== pause || pause.action !== "resume" || ownTurns.has(thread.id))
        return;
      paused.delete(thread.id);
      const text = pause.held?.turnId === null ? pause.held.text : AGENT_CONTINUE_PROMPT;
      // startTurn reserves the thread synchronously, before the next yield.
      const started = startTurn(thread, text, pause.held?.delivery ?? null, messageId);
      const own = ownTurns.get(thread.id);
      if (own && pause.held?.replied) own.replied = true;
      yield* started;
      yield* publishControl;
    } else {
      paused.delete(thread.id);
      yield* publishControl;
      // A held turn that finished normally: its answer is due now.
      if (pause.action === "resume" && pause.held && pause.heldSession) {
        yield* routeReply({ ...thread, session: pause.heldSession }, pause.held, false);
      }
      yield* drainQueue(thread.id);
    }
  });

  const handleJob = Effect.fnUntraced(function* (job: Job) {
    const threads = yield* shells;
    const thread = threads.find((entry) => entry.id === job.threadId);
    if (!thread) return;
    switch (job.kind) {
      case "turn-ended": {
        if (ownTurns.get(job.threadId) === job.turn) ownTurns.delete(job.threadId);
        const endedThread = { ...thread, session: job.session };
        const hitLimit = yield* updateLimit(endedThread, job.signal, true);
        // Stopped by the user (providers report an interrupted turn as
        // "interrupted" or as an ordinary "ready"): Resume continues it, and
        // its answer still goes to the requester.
        const pause = paused.get(job.threadId);
        if (pause?.action === "discard" || (pause && !hitLimit)) {
          // A turn that bound after the Stop and still finished normally was
          // not cut short: Resume delivers its answer instead of continuing.
          const latest = thread.latestTurn;
          const cutShort =
            !job.turn.stopIssued ||
            job.session.status !== "ready" ||
            (latest?.turnId === job.turn.turnId && latest.state === "interrupted");
          paused.set(job.threadId, {
            ...pause,
            interrupted: cutShort,
            held: job.turn,
            heldSession: job.session,
          });
          yield* publishControl;
          yield* finishPause(thread);
          return;
        }
        yield* routeReply(endedThread, job.turn, hitLimit);
        if (!hitLimit && job.session.status === "ready" && !job.session.lastError) {
          yield* clearInstance(instanceOf(thread));
        }
        yield* drainQueue(job.threadId);
        return;
      }
      case "hold-turn": {
        // The agent was stopped while this turn was still being sent.
        if (ownTurns.get(job.threadId) !== job.turn || job.turn.finishing) return;
        if (!paused.has(job.threadId) || job.turn.turnId === null) return;
        job.turn.stopIssued = true;
        const commandId = CommandId.make(`server:agent-stop:${yield* uuid}`);
        ownStopCommands.add(commandId);
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId,
            threadId: job.threadId,
            turnId: job.turn.turnId,
            createdAt: yield* nowIso,
          })
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                ownStopCommands.delete(commandId);
              }),
            ),
          );
        return;
      }
      case "idle": {
        if (ownTurns.has(job.threadId)) return;
        yield* updateLimit(thread, job.signal, false);
        if (
          thread.session?.status === "ready" &&
          !thread.session.lastError &&
          thread.latestTurn?.state === "completed"
        ) {
          yield* clearInstance(instanceOf(thread));
        }
        yield* finishPause(thread);
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
        const stoppedTurn = pause.held ?? ownTurns.get(job.threadId);
        const held = stoppedTurn?.delivery;
        if (stoppedTurn) stoppedTurn.discarded = true;
        if (held?.replyExpected && !stoppedTurn?.replied) {
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
          signals.delete(event.payload.threadId);
          const own = ownTurns.get(event.payload.threadId);
          if (own && own.messageId === event.payload.messageId) {
            return Effect.void;
          }
          return worker.enqueue({ kind: "user-prompt", threadId: event.payload.threadId });
        }
        case "thread.turn-interrupt-requested":
        case "thread.session-stop-requested": {
          if (event.commandId && ownStopCommands.delete(event.commandId)) return Effect.void;
          const threadId = event.payload.threadId;
          return worker.enqueue({ kind: "stopped", threadId, interrupted: active.has(threadId) });
        }
        case "thread.session-set": {
          const { threadId, session } = event.payload;
          const live = isLive(session.status);
          if (live) active.add(threadId);
          else active.delete(threadId);
          const own = ownTurns.get(threadId);
          if (own) {
            own.lastSession = session;
            const previous = own.observedTurnId;
            if (
              previous &&
              (!live || (session.activeTurnId && session.activeTurnId !== previous))
            ) {
              own.ended.set(previous, session);
            }
            own.observedTurnId = session.activeTurnId;
            if (!own.finishing && own.turnId !== null && own.ended.has(own.turnId)) {
              own.finishing = true;
              return worker.enqueue({
                kind: "turn-ended",
                threadId,
                turn: own,
                session: own.ended.get(own.turnId)!,
                signal: signals.get(threadId),
              });
            }
          }
          return live
            ? Effect.void
            : worker.enqueue({ kind: "idle", threadId, signal: signals.get(threadId) });
        }
        case "thread.activity-appended": {
          const { threadId, activity } = event.payload;
          if (activity.kind === "runtime.warning") {
            // A rejected usage window carries the provider's own reset time.
            const signal = mergeRateLimitSignal(
              signals.get(threadId),
              (activity.payload as { readonly detail?: unknown } | null)?.detail,
            );
            if (signal !== undefined) signals.set(threadId, signal);
            return Effect.void;
          }
          if (
            activity.kind !== "provider.turn.start.accepted" &&
            activity.kind !== "provider.turn.start.failed"
          )
            return Effect.void;
          const decoded = decodeTurnStartReceipt(activity.payload);
          if (Option.isNone(decoded)) return Effect.void;
          const payload = decoded.value;
          const own = ownTurns.get(threadId);
          if (!own || own.finishing || payload.requestId !== own.messageId) return Effect.void;
          if (activity.kind === "provider.turn.start.accepted" && activity.turnId !== null) {
            own.turnId = activity.turnId;
            // Stopped or finished before the receipt: the turn is already over.
            const last = own.lastSession;
            const session =
              own.ended.get(own.turnId) ?? (last && !isLive(last.status) ? last : undefined);
            if (!session) {
              return paused.has(threadId)
                ? worker.enqueue({ kind: "hold-turn", threadId, turn: own })
                : Effect.void;
            }
            own.finishing = true;
            return worker.enqueue({
              kind: "turn-ended",
              threadId,
              turn: own,
              session,
              signal: signals.get(threadId),
            });
          }
          if (activity.kind === "provider.turn.start.failed") {
            own.finishing = true;
            return worker.enqueue({
              kind: "turn-ended",
              threadId,
              turn: own,
              signal: signals.get(threadId),
              session: {
                threadId,
                status: "error",
                activeTurnId: null,
                providerName: null,
                runtimeMode: "full-access",
                lastError:
                  typeof payload.detail === "string"
                    ? payload.detail
                    : "Provider turn start failed",
                updatedAt: activity.createdAt,
              },
            });
          }
          return Effect.void;
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
        const running = isBusy(thread) || active.has(thread.id) || ownTurns.has(thread.id);
        if (inTree) pauseThread(thread.id, running);
        if (!running) {
          if (inTree) changed.push(thread.id);
          continue;
        }
        changed.push(thread.id);
        const turnId =
          thread.session?.status === "running" ? thread.session.activeTurnId : undefined;
        const commandId = CommandId.make(`server:agent-stop:${yield* uuid}`);
        ownStopCommands.add(commandId);
        yield* engine
          .dispatch({
            type: "thread.turn.interrupt",
            commandId,
            threadId: thread.id,
            ...(turnId ? { turnId } : {}),
            createdAt,
          })
          .pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                ownStopCommands.delete(commandId);
              }),
            ),
          );
      }
      yield* publishControl;
      return { threadIds: changed };
    }).pipe(Effect.mapError(controlError));

  const resume: AgentMessagingShape["resume"] = (input) =>
    Effect.gen(function* () {
      const { targets } = yield* scopeOf(input);
      const resumed: ThreadId[] = [];
      for (const thread of targets) {
        const pause = paused.get(thread.id);
        if (pause?.action === "discard") continue;
        if (pause) {
          pause.action = "resume";
          resumed.push(thread.id);
          yield* finishPause(thread);
        } else {
          yield* drainQueue(thread.id);
        }
      }
      return { threadIds: resumed };
    }).pipe(Effect.mapError(controlError));

  const discard: AgentMessagingShape["discard"] = (input) =>
    Effect.gen(function* () {
      const { targets } = yield* scopeOf(input);
      const changed = targets
        .filter((thread) => {
          const had = paused.has(thread.id) || queues.has(thread.id);
          const pause = paused.get(thread.id);
          if (pause && (ownTurns.has(thread.id) || isBusy(thread))) {
            pause.action = "discard";
            const own = ownTurns.get(thread.id);
            if (own) own.discarded = true;
          } else paused.delete(thread.id);
          queues.delete(thread.id);
          return had;
        })
        .map((thread) => thread.id);
      yield* publishControl;
      return { threadIds: changed };
    }).pipe(Effect.mapError(controlError));

  const continueAfterLimit: AgentMessagingShape["continueAfterLimit"] = (
    threadId,
    messageId,
    reason,
  ) =>
    Effect.gen(function* () {
      const thread = (yield* shells).find((entry) => entry.id === threadId);
      if (!thread || thread.archivedAt !== null) return "gone" as const;
      if (paused.has(threadId)) return "paused" as const;
      if (ownTurns.has(threadId) || isBusy(thread)) return "busy" as const;
      limited.delete(threadId);
      const prompt = reason === "usage" ? USAGE_RESET_CONTINUE_PROMPT : AGENT_CONTINUE_PROMPT;
      yield* startTurn(thread, prompt, null, messageId).pipe(
        Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })),
      );
      return "started" as const;
    });

  const wake: AgentMessagingShape["wake"] = (threadId, messageId, text) =>
    Effect.gen(function* () {
      const thread = (yield* shells).find((entry) => entry.id === threadId);
      if (!thread || thread.archivedAt !== null) return "gone" as const;
      if (paused.has(threadId) || blocks(threadId, yield* now)) return "held" as const;
      if (ownTurns.has(threadId) || isBusy(thread) || (queues.get(threadId)?.length ?? 0) > 0) {
        return "busy" as const;
      }
      yield* startTurn(thread, text, null, messageId).pipe(
        Effect.mapError((cause) => new AgentMessagingError({ reason: String(cause) })),
      );
      return "started" as const;
    });

  const start: AgentMessagingShape["start"] = Effect.fn("AgentMessaging.start")(function* () {
    const events = yield* engine.subscribeDomainEvents;
    const providerChanges = providerRegistry.streamChanges;
    yield* forkParked(Stream.runForEach(events, processEvent));
    yield* forkParked(
      Effect.all(
        [
          limitTimer,
          Stream.runForEach(providerChanges, (providers) =>
            onProvidersChanged(providers).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("agent messaging failed to read a usage snapshot", {
                  cause: Cause.pretty(cause),
                }),
              ),
            ),
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
  });

  const setUsageResume: AgentMessagingShape["setUsageResume"] = (threadId, state) =>
    Effect.suspend(() => {
      if (state === null) usageStates.delete(threadId);
      else usageStates.set(threadId, state);
      return publishControl;
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
    continueAfterLimit,
    wake,
    setUsageResume,
    controlChanges: SubscriptionRef.changes(control),
    start,
    drain: worker.drain,
  } satisfies AgentMessagingShape;
});

export const layer = Layer.effect(AgentMessaging, make);
