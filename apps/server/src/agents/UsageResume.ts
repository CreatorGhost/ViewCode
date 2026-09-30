import {
  CommandId,
  EventId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  ThreadId,
  USAGE_RESUME_ACTIVITY_KIND,
  type UsageResumePayload,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { classifyLimitError } from "@t3tools/shared/usageLimit";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { DesktopTelemetryReceiver } from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentMessaging, AgentMessagingError } from "./AgentMessaging.ts";
import {
  type RateLimitSignal,
  USAGE_RESET_MARGIN_MS,
  freshUsageWindows,
  limitKindOf,
  mergeRateLimitSignal,
  pickResetTime,
} from "./usageResetTime.ts";

/**
 * Continues a thread by itself once its provider's usage limit resets, or
 * shortly after a transient throttle.
 *
 * A turn that ends with a usage-limit error schedules the usage-reset continue
 * prompt for the reset time plus a minute (at least five seconds out). The
 * reset time comes from the provider's own signal recorded during the turn,
 * else the error text, else a recent usage reading; only a future time counts.
 * A turn a server or proxy throttled for a moment ("temporarily limiting
 * requests", HTTP 429, a retry hint under five minutes) is retried after 10s,
 * 30s and 60s instead, with a plain "continue", and never counts as out of
 * usage. One failure is decided once, however many events report it: the
 * decision is keyed by the turn request that failed.
 *
 * Child agents are left to their lead (see AgentMessaging); every other thread
 * resumes here. The schedule is one JSON file per thread under
 * `<stateDir>/usage-resume/`, so it survives a restart; one sleeping fiber
 * waits for the earliest schedule and is woken whenever the set changes. Any
 * user turn, a model switch, Cancel, Resume now, archiving or deleting drops
 * it. A resume that hits the limit again is rescheduled once from the fresh
 * reset time. A resume due while the thread is busy waits a minute more; one
 * due while the user has the agent stopped is cancelled.
 *
 * The desktop is told whether any resume is pending so it can keep the
 * computer from suspending. Nothing wakes a sleeping computer.
 */

/** Wait past the reset so the provider has certainly cleared the window. */
export const USAGE_RESUME_DELAY_MS = USAGE_RESET_MARGIN_MS;
/** A resume is never scheduled closer than this. */
export const USAGE_RESUME_MIN_DELAY_MS = 5_000;
/** Resumes attempted for one stretch of being out of usage before giving up. */
export const USAGE_RESUME_MAX_ATTEMPTS = 2;
/** An overdue schedule found at startup runs this long after boot. */
export const USAGE_RESUME_STARTUP_GRACE_MS = 5_000;
/** A due resume finds the thread busy: it tries again this much later. */
export const USAGE_RESUME_BUSY_RETRY_MS = 60_000;
/** Waits before each retry of a transiently throttled turn; then it stops. */
export const TRANSIENT_RETRY_DELAYS_MS = [10_000, 30_000, 60_000] as const;
/** What a resume after a usage limit reset records; phone notifications key on it. */
export const USAGE_RESUME_AUTO_SUMMARY = "Trying to continue after the usage limit…";
/** A reset further away than this is more likely a misread than a limit. */
const MAX_RESET_HORIZON_MS = 14 * 24 * 60 * 60 * 1000;

const ScheduleJson = Schema.fromJsonString(
  Schema.Struct({
    resumeAt: Schema.Number,
    resetsAt: Schema.Number,
    /** Resumes (or transient retries) already attempted; carries the give-up limit across a restart. */
    attempts: Schema.Number,
    modelKey: Schema.String,
    /** A transient retry rather than a usage-limit resume; absent in older files. */
    transient: Schema.optional(Schema.Boolean),
  }),
);
type Schedule = typeof ScheduleJson.Type;
const decodeSchedule = Schema.decodeUnknownOption(ScheduleJson);
const encodeSchedule = Schema.encodeSync(ScheduleJson);

const encodePayloadKey = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const modelKeyOf = (selection: ModelSelection) => `${selection.instanceId}/${selection.model}`;

type Job =
  | {
      readonly kind: "failed";
      readonly threadId: ThreadId;
      readonly error: string;
      /** The provider's own rate-limit signal seen during the turn. */
      readonly recorded: RateLimitSignal | undefined;
      /** The turn request that failed; every event of one failure shares it. */
      readonly request: string;
    }
  | { readonly kind: "ready"; readonly threadId: ThreadId }
  | { readonly kind: "user-turn"; readonly threadId: ThreadId }
  | { readonly kind: "model"; readonly threadId: ThreadId; readonly modelKey: string }
  | { readonly kind: "removed"; readonly threadId: ThreadId };

export interface UsageResumeShape {
  /** Drops the thread's schedule. False when it had none. */
  readonly cancel: (threadId: ThreadId) => Effect.Effect<boolean>;
  /** Continues the thread now, whether or not a resume was scheduled. */
  readonly resumeNow: (threadId: ThreadId) => Effect.Effect<boolean, AgentMessagingError>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class UsageResume extends Context.Service<UsageResume, UsageResumeShape>()(
  "t3/agents/UsageResume",
) {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const registry = yield* ProviderRegistry;
  const settingsService = yield* ServerSettingsService;
  const messaging = yield* AgentMessaging;
  const desktop = yield* DesktopTelemetryReceiver;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const dir = path.join(config.stateDir, "usage-resume");
  const fileOf = (threadId: string) => path.join(dir, `${encodeURIComponent(threadId)}.json`);

  const schedules = new Map<string, Schedule>();
  // Usage-limit resumes attempted since the user last acted on the thread.
  const attempts = new Map<string, number>();
  // Transient retries attempted since the user last acted or a turn succeeded.
  const retries = new Map<string, number>();
  // Resume turns this service started, so they are not mistaken for the user.
  const ours = new Set<string>();
  const lastNote = new Map<string, string>();
  // The provider's own rate-limit signal seen during each thread's running turn.
  const signals = new Map<string, RateLimitSignal>();
  // The latest turn request per thread, and the one whose failure was already decided.
  const requests = new Map<string, string>();
  const decided = new Map<string, string>();
  const changed = yield* Queue.sliding<void>(1);
  let awakeHeld = false;

  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);
  const now = Clock.currentTimeMillis;
  const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
  const wake = Queue.offer(changed, undefined).pipe(Effect.asVoid);
  const warn = (message: string) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logWarning(message, { cause: Cause.pretty(cause) }),
    );

  const shells = projections.getShellSnapshot().pipe(Effect.map((snapshot) => snapshot.threads));
  const findThread = (threadId: ThreadId) =>
    shells.pipe(
      Effect.map((threads): OrchestrationThreadShell | undefined =>
        threads.find((thread) => thread.id === threadId),
      ),
    );

  /** Tells the desktop whether to hold the no-suspend assertion. */
  const syncAwake = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    const want = schedules.size > 0 && settings.keepAwakeForUsageResume;
    if (want === awakeHeld) return;
    awakeHeld = want;
    yield* desktop.setKeepAwake(want);
  }).pipe(warn("failed to update the keep-awake request"));

  /** What clients show. The latest one per thread wins; identical repeats are skipped. */
  const note = Effect.fnUntraced(function* (
    threadId: ThreadId,
    payload: UsageResumePayload,
    summary: string,
  ) {
    const key = encodePayloadKey(payload);
    if (lastNote.get(threadId) === key) return;
    lastNote.set(threadId, key);
    const createdAt = iso(yield* now);
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:usage-resume:${yield* uuid}`),
        threadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: USAGE_RESUME_ACTIVITY_KIND,
          summary,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(warn("failed to record the usage-limit resume state"));
  });

  const persist = (threadId: string, schedule: Schedule) =>
    fileSystem
      .makeDirectory(dir, { recursive: true })
      .pipe(
        Effect.andThen(fileSystem.writeFileString(fileOf(threadId), encodeSchedule(schedule))),
        warn("failed to persist the usage-limit resume schedule"),
      );
  const forget = (threadId: string) =>
    fileSystem
      .remove(fileOf(threadId), { force: true })
      .pipe(warn("failed to remove the usage-limit resume schedule"));

  /** When the limit resets: the recorded signal, else the error text, else a recent spent usage window. */
  const resolveReset = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    error: string,
    recorded: RateLimitSignal | undefined,
    nowMs: number,
  ) {
    const providers = yield* registry.getProviders;
    const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
    const usage = providers.find((entry) => entry.instanceId === instanceId)?.usageLimits;
    const windows = freshUsageWindows(usage, nowMs);
    return pickResetTime({ recorded, text: error, windows, nowMs });
  });

  /** What the control stream tells clients: stopped on a limit, with a resume time when scheduled. */
  const publishState = (threadId: ThreadId, state: { readonly resumeAt?: string } | null) =>
    messaging.setUsageResume(threadId, state).pipe(warn("failed to publish the usage-limit state"));

  /** Arms a schedule and tells clients; `payload` is what the thread shows. */
  const arm = Effect.fnUntraced(function* (
    threadId: ThreadId,
    schedule: Schedule,
    payload: UsageResumePayload,
    summary: string,
  ) {
    schedules.set(threadId, schedule);
    yield* persist(threadId, schedule);
    // The control stream is about usage limits; a throttle is an ordinary failure there.
    if (!schedule.transient) yield* publishState(threadId, { resumeAt: iso(schedule.resumeAt) });
    yield* note(threadId, payload, summary);
    yield* syncAwake;
    yield* wake;
  });

  const handleUsageLimit = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    error: string,
    recorded: RateLimitSignal | undefined,
    nowMs: number,
  ) {
    const threadId = thread.id;
    const resetsAt = yield* resolveReset(thread, error, recorded, nowMs);
    // A child is left to its lead, who is told when it resets (see AgentMessaging).
    // The banner still says when, and Resume now still works.
    const leftToLead = thread.parentThreadId != null;
    if (resetsAt === null || resetsAt - nowMs > MAX_RESET_HORIZON_MS) {
      if (!leftToLead) yield* publishState(threadId, {});
      return yield* note(
        threadId,
        { state: "unknown" },
        "Out of usage; ViewCode can't tell when it resets.",
      );
    }
    const resumeAt = Math.max(resetsAt + USAGE_RESUME_DELAY_MS, nowMs + USAGE_RESUME_MIN_DELAY_MS);
    const times = { resetsAt: iso(resetsAt), resumeAt: iso(resumeAt) };
    const settings = yield* settingsService.getSettings;
    if (leftToLead || !settings.resumeAfterUsageLimit) {
      if (!leftToLead) yield* publishState(threadId, {});
      return yield* note(threadId, { state: "reset-known", ...times }, "Out of usage.");
    }
    const done = attempts.get(threadId) ?? 0;
    if (done >= USAGE_RESUME_MAX_ATTEMPTS) {
      attempts.delete(threadId);
      yield* publishState(threadId, {});
      return yield* note(
        threadId,
        { state: "gave-up", ...times },
        "Out of usage; automatic resume stopped after two tries.",
      );
    }
    yield* arm(
      threadId,
      { resumeAt, resetsAt, attempts: done, modelKey: modelKeyOf(thread.modelSelection) },
      { state: "scheduled", ...times },
      "Out of usage; resumes automatically.",
    );
  });

  /** A server or proxy throttled the turn: retry it shortly, a few times, then leave it to the user. */
  const handleTransient = Effect.fnUntraced(function* (
    thread: OrchestrationThreadShell,
    retryAt: number | null,
    nowMs: number,
  ) {
    const threadId = thread.id;
    if (thread.parentThreadId != null) return;
    const settings = yield* settingsService.getSettings;
    if (!settings.resumeAfterUsageLimit) return;
    const done = retries.get(threadId) ?? 0;
    const delay = TRANSIENT_RETRY_DELAYS_MS[done];
    if (delay === undefined) {
      retries.delete(threadId);
      return yield* note(
        threadId,
        { state: "cancelled" },
        `Still rate limited after ${TRANSIENT_RETRY_DELAYS_MS.length} retries; send a message to try again.`,
      );
    }
    const resumeAt = Math.max(nowMs + delay, retryAt ?? 0);
    yield* arm(
      threadId,
      {
        resumeAt,
        resetsAt: resumeAt,
        attempts: done,
        modelKey: modelKeyOf(thread.modelSelection),
        transient: true,
      },
      { state: "rate-limited", resumeAt: iso(resumeAt) },
      "Rate limited by the server; retrying automatically.",
    );
  });

  const handleFailure = Effect.fnUntraced(function* (job: Extract<Job, { kind: "failed" }>) {
    const { threadId } = job;
    // A Claude failure arrives as several events (runtime error, turn end, a
    // later idle); the first decides and the rest are the same failure.
    if (decided.get(threadId) === job.request) return;
    decided.set(threadId, job.request);
    if (schedules.has(threadId)) return;
    const thread = yield* findThread(threadId);
    if (!thread || thread.archivedAt !== null) return;
    const nowMs = yield* now;
    const kind = limitKindOf(job.error, nowMs, job.recorded);
    if (kind === null) return;
    if (kind.kind === "transient") return yield* handleTransient(thread, kind.retryAt, nowMs);
    retries.delete(threadId);
    yield* handleUsageLimit(thread, job.error, job.recorded, nowMs);
  });

  /** Removes the schedule and forgets the attempt counts; says so unless silent. */
  const drop = Effect.fnUntraced(function* (threadId: ThreadId, silent: boolean) {
    attempts.delete(threadId);
    retries.delete(threadId);
    const schedule = schedules.get(threadId);
    schedules.delete(threadId);
    yield* publishState(threadId, null);
    if (schedule) {
      yield* forget(threadId);
      yield* syncAwake;
      yield* wake;
    }
    if (silent) {
      lastNote.delete(threadId);
    } else if (schedule) {
      yield* note(threadId, { state: "cancelled" }, "Automatic resume cancelled.");
    } else {
      lastNote.delete(threadId);
    }
    return schedule !== undefined;
  });

  /**
   * Continues the thread. The schedule is taken out first, so the continued
   * turn's own failure is decided afresh and counted against the attempts; it
   * is put back when nothing started. The "resumed" note only follows a turn
   * that did start.
   */
  const fire = Effect.fnUntraced(function* (threadId: ThreadId, manual: boolean) {
    const schedule = schedules.get(threadId);
    const transient = schedule?.transient === true;
    const counted = { attempts: attempts.get(threadId), retries: retries.get(threadId) };
    schedules.delete(threadId);
    const done = schedule?.attempts ?? 0;
    if (manual) {
      attempts.delete(threadId);
      retries.delete(threadId);
    } else if (transient) {
      retries.set(threadId, done + 1);
    } else {
      attempts.set(threadId, done + 1);
    }
    if (schedule) yield* forget(threadId);
    /** Nothing started: the counts and the schedule are as they were. */
    const restore = Effect.fnUntraced(function* () {
      for (const [map, value] of [
        [attempts, counted.attempts],
        [retries, counted.retries],
      ] as const) {
        if (value === undefined) map.delete(threadId);
        else map.set(threadId, value);
      }
      if (schedule) {
        schedules.set(threadId, schedule);
        yield* persist(threadId, schedule);
      }
    });

    const messageId = MessageId.make(yield* uuid);
    ours.add(messageId);
    const outcome = yield* messaging
      .continueAfterLimit(threadId, messageId, transient ? "transient" : "usage")
      .pipe(
        Effect.tapError(() =>
          Effect.gen(function* () {
            ours.delete(messageId);
            yield* restore();
            // A due resume that cannot even be sent is dropped, not retried on every change.
            if (!manual && schedule) yield* drop(threadId, false);
          }),
        ),
      );
    if (outcome !== "started") {
      ours.delete(messageId);
      yield* restore();
      // Resume now leaves any schedule as it was.
      if (manual || !schedule) return false;
      if (outcome !== "busy") {
        // Archived, deleted or stopped by the user: nothing should run.
        yield* drop(threadId, outcome === "gone");
        return false;
      }
      // Busy with other work: try again shortly rather than show a time that has passed.
      const resumeAt = (yield* now) + USAGE_RESUME_BUSY_RETRY_MS;
      yield* arm(
        threadId,
        { ...schedule, resumeAt },
        transient
          ? { state: "rate-limited", resumeAt: iso(resumeAt) }
          : { state: "scheduled", resetsAt: iso(schedule.resetsAt), resumeAt: iso(resumeAt) },
        "The thread is busy; resuming a little later.",
      );
      return false;
    }
    yield* publishState(threadId, null);
    yield* note(
      threadId,
      { state: "resumed" },
      manual
        ? "Resumed by you."
        : transient
          ? "Retrying after the rate limit…"
          : USAGE_RESUME_AUTO_SUMMARY,
    );
    if (schedule) yield* syncAwake;
    return true;
  });

  const handleJob = Effect.fnUntraced(function* (job: Job) {
    switch (job.kind) {
      case "failed":
        return yield* handleFailure(job);
      case "ready":
        // A pending resume is not undone by an idle report; only a user action drops it.
        if (schedules.has(job.threadId)) return;
        attempts.delete(job.threadId);
        retries.delete(job.threadId);
        yield* publishState(job.threadId, null);
        return;
      case "user-turn":
        yield* drop(job.threadId, false);
        return;
      case "model": {
        const schedule = schedules.get(job.threadId);
        if (schedule && schedule.modelKey !== job.modelKey) yield* drop(job.threadId, false);
        return;
      }
      case "removed":
        // Archived or deleted: nothing runs in it, and keep-awake is released.
        yield* drop(job.threadId, true);
        decided.delete(job.threadId);
        requests.delete(job.threadId);
        signals.delete(job.threadId);
        return;
    }
  });

  const worker = yield* makeDrainableWorker((job: Job) =>
    handleJob(job).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("usage resume failed to handle a thread event", {
          threadId: job.threadId,
          kind: job.kind,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const isLiveStatus = (session: OrchestrationSession) =>
    session.status === "running" || session.status === "starting";

  const failed = (threadId: ThreadId, error: string) =>
    worker.enqueue({
      kind: "failed",
      threadId,
      error,
      recorded: signals.get(threadId),
      request: requests.get(threadId) ?? "",
    });

  const processEvent = (event: OrchestrationEvent) =>
    Effect.suspend(() => {
      switch (event.type) {
        case "thread.session-set": {
          const { threadId, session } = event.payload;
          if (isLiveStatus(session)) return Effect.void;
          if (session.status === "error" || session.status === "ready") {
            if (classifyLimitError(session.lastError) !== null) {
              return failed(threadId, session.lastError!);
            }
            if (session.status === "ready") return worker.enqueue({ kind: "ready", threadId });
          }
          return Effect.void;
        }
        case "thread.activity-appended": {
          const { threadId, activity } = event.payload;
          const detail = (activity.payload as { readonly detail?: unknown } | null)?.detail;
          if (activity.kind === "runtime.warning") {
            // A rejected usage window carries the provider's own reset time.
            const signal = mergeRateLimitSignal(signals.get(threadId), detail);
            if (signal !== undefined) signals.set(threadId, signal);
            return Effect.void;
          }
          if (activity.kind !== "provider.turn.start.failed") return Effect.void;
          return typeof detail === "string" && classifyLimitError(detail) !== null
            ? failed(threadId, detail)
            : Effect.void;
        }
        case "thread.turn-start-requested": {
          const messageId = String(event.payload.messageId);
          signals.delete(event.payload.threadId);
          requests.set(event.payload.threadId, messageId);
          if (ours.delete(messageId)) return Effect.void;
          return worker.enqueue({ kind: "user-turn", threadId: event.payload.threadId });
        }
        case "thread.meta-updated": {
          const selection = event.payload.modelSelection;
          return selection
            ? worker.enqueue({
                kind: "model",
                threadId: event.payload.threadId,
                modelKey: modelKeyOf(selection),
              })
            : Effect.void;
        }
        case "thread.archived":
        case "thread.deleted":
          return worker.enqueue({ kind: "removed", threadId: event.payload.threadId });
        default:
          return Effect.void;
      }
    });

  /** Runs what is due, then sleeps until the earliest schedule or a change. */
  const timerLoop = Effect.gen(function* () {
    while (true) {
      const nowMs = yield* now;
      let next: number | null = null;
      for (const [threadId, schedule] of [...schedules]) {
        if (schedule.resumeAt <= nowMs) {
          yield* fire(ThreadId.make(threadId), false).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("usage resume failed to continue a thread", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          );
        } else if (next === null || schedule.resumeAt < next) {
          next = schedule.resumeAt;
        }
      }
      // A schedule pushed back while firing woke `changed`, so it is seen next round.
      if (next === null) {
        yield* Queue.take(changed);
      } else {
        // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - one sleep to the earliest resume, cut short when the schedule set changes
        yield* Effect.raceFirst(Queue.take(changed), Effect.sleep(Duration.millis(next - nowMs)));
      }
    }
  });

  const load = Effect.gen(function* () {
    const entries = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const nowMs = yield* now;
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const text = yield* fileSystem
        .readFileString(path.join(dir, entry))
        .pipe(Effect.orElseSucceed(() => ""));
      const decoded = decodeSchedule(text);
      if (Option.isNone(decoded)) continue;
      const threadId = decodeURIComponent(entry.slice(0, -".json".length));
      const schedule = decoded.value;
      // Overdue after downtime: run shortly after startup, not in the boot burst.
      schedules.set(threadId, {
        ...schedule,
        resumeAt: Math.max(schedule.resumeAt, nowMs + USAGE_RESUME_STARTUP_GRACE_MS),
      });
      (schedule.transient ? retries : attempts).set(threadId, schedule.attempts);
      if (!schedule.transient) {
        yield* publishState(ThreadId.make(threadId), { resumeAt: iso(schedule.resumeAt) });
      }
    }
  }).pipe(warn("failed to load usage-limit resume schedules"));

  const start: UsageResumeShape["start"] = Effect.fn("UsageResume.start")(function* () {
    yield* load;
    const settingsChanges = yield* settingsService.subscribeChanges;
    const events = yield* engine.subscribeDomainEvents;
    yield* syncAwake;
    yield* forkParked(
      Effect.all(
        [
          Stream.runForEach(events, processEvent),
          Stream.runForEach(settingsChanges, () => syncAwake),
          timerLoop,
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
    yield* wake;
  });

  return {
    cancel: (threadId) => drop(threadId, false),
    resumeNow: (threadId) => fire(threadId, true),
    start,
    drain: worker.drain,
  } satisfies UsageResumeShape;
});

export const layer = Layer.effect(UsageResume, make);
