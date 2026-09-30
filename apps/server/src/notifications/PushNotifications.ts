import {
  type AuthSessionId,
  type EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  PushNotificationCategories,
  PushNotificationError,
  type PushRegisterInput,
  type PushRegistrationResult,
  type ThreadId,
  USAGE_RESUME_ACTIVITY_KIND,
  UsageResumePayload,
} from "@t3tools/contracts";
import { projectThreadAwareness } from "@t3tools/shared/agentAwareness";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { USAGE_RESUME_AUTO_SUMMARY } from "../agents/UsageResume.ts";
import { writeFileStringAtomically } from "../atomicWrite.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { eventThreadId, shouldPublishAgentAwarenessEvent } from "../relay/AgentAwarenessRelay.ts";
import { forkParked } from "../serverActivation.ts";
import {
  PUSH_EVENT_CATEGORY,
  type PushEventKind,
  type ThreadTrack,
  decideThreadNotification,
  decideUsageResumeNotification,
  formatPushNotification,
} from "./pushNotificationRules.ts";

/**
 * Phone notifications straight from this environment through Expo's push
 * service, for clients that never signed in to T3 Connect (whose relay has its
 * own FCM/APNs delivery). A phone registers its Expo push token over its own
 * authenticated connection; the token is kept per client session in
 * `<stateDir>/push-devices.json` and dropped when that session is revoked or
 * expires, when the phone unregisters, or when Expo reports the device gone.
 *
 * Only a thread's title and a few words about the event are sent, never
 * message text or errors. Expo forwards to FCM with the credentials uploaded
 * to the app's EAS project; nothing here holds a Google or Apple key.
 */

export const EXPO_PUSH_URL = "https://exp.host/--/api/v2/push/send";
/** The Android channel the app creates for agent alerts. */
export const PUSH_ANDROID_CHANNEL = "agent-alerts";
const MAX_LEAD_HOPS = 24;

export const PushDevice = Schema.Struct({
  sessionId: Schema.String,
  token: Schema.String,
  platform: Schema.Literals(["android", "ios"]),
  categories: PushNotificationCategories,
  updatedAt: Schema.String,
});
export type PushDevice = typeof PushDevice.Type;

const DevicesJson = Schema.fromJsonString(Schema.Array(PushDevice));
const decodeDevices = Schema.decodeUnknownOption(DevicesJson);
const encodeDevices = Schema.encodeSync(DevicesJson);
const decodeUsageResumePayload = Schema.decodeUnknownOption(UsageResumePayload);

/** One registration per client session; a token re-registered from a new pairing moves with it. */
export function upsertPushDevice(
  devices: ReadonlyArray<PushDevice>,
  device: PushDevice,
): ReadonlyArray<PushDevice> {
  return [
    ...devices.filter(
      (existing) => existing.sessionId !== device.sessionId && existing.token !== device.token,
    ),
    device,
  ];
}

/** Devices whose client session is still active. */
export function keepActivePushDevices(
  devices: ReadonlyArray<PushDevice>,
  activeSessionIds: ReadonlySet<string>,
): ReadonlyArray<PushDevice> {
  return devices.filter((device) => activeSessionIds.has(device.sessionId));
}

/** Tokens that want this category, each once. */
export function pushRecipients(
  devices: ReadonlyArray<PushDevice>,
  category: keyof PushNotificationCategories,
): ReadonlyArray<PushDevice> {
  const seen = new Set<string>();
  return devices.filter((device) => {
    if (!device.categories[category] || seen.has(device.token)) return false;
    seen.add(device.token);
    return true;
  });
}

export interface ExpoPushMessage {
  readonly to: string;
  readonly title: string;
  readonly body: string;
  readonly data: {
    readonly kind: PushEventKind;
    readonly environmentId: string;
    readonly threadId: string;
    readonly deepLink: string;
  };
  readonly channelId: string;
  readonly priority: "high";
  readonly sound: "default";
}

/** Per message, in order: whether Expo says the device is gone for good. */
export interface ExpoPushTicket {
  readonly ok: boolean;
  readonly deviceNotRegistered: boolean;
}

export class ExpoPushSender extends Context.Service<
  ExpoPushSender,
  {
    readonly send: (
      messages: ReadonlyArray<ExpoPushMessage>,
    ) => Effect.Effect<ReadonlyArray<ExpoPushTicket>, PushNotificationError>;
  }
>()("t3/notifications/ExpoPushSender") {}

const ExpoPushResponse = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      status: Schema.String,
      details: Schema.optional(Schema.Struct({ error: Schema.optional(Schema.String) })),
    }),
  ),
});

export const expoPushSenderLayer = Layer.effect(
  ExpoPushSender,
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return ExpoPushSender.of({
      send: (messages) =>
        client
          .execute(
            HttpClientRequest.post(EXPO_PUSH_URL).pipe(
              HttpClientRequest.setHeaders({ accept: "application/json" }),
              HttpClientRequest.bodyJsonUnsafe(messages),
            ),
          )
          .pipe(
            Effect.flatMap(HttpClientResponse.filterStatusOk),
            Effect.flatMap(HttpClientResponse.schemaBodyJson(ExpoPushResponse)),
            Effect.map((response) =>
              response.data.map((ticket) => ({
                ok: ticket.status === "ok",
                deviceNotRegistered: ticket.details?.error === "DeviceNotRegistered",
              })),
            ),
            Effect.timeout("15 seconds"),
            Effect.mapError(
              (cause) =>
                new PushNotificationError({
                  detail: `Expo push request failed: ${String(cause)}`,
                }),
            ),
          ),
    });
  }),
).pipe(Layer.provide(FetchHttpClient.layer));

export interface PushNotificationsShape {
  readonly register: (
    sessionId: AuthSessionId,
    input: PushRegisterInput,
  ) => Effect.Effect<PushRegistrationResult, PushNotificationError>;
  readonly unregister: (
    sessionId: AuthSessionId,
  ) => Effect.Effect<PushRegistrationResult, PushNotificationError>;
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class PushNotifications extends Context.Service<PushNotifications, PushNotificationsShape>()(
  "t3/notifications/PushNotifications",
) {}

type Job =
  | { readonly kind: "revoked"; readonly sessionId: AuthSessionId }
  | { readonly kind: "thread"; readonly threadId: ThreadId }
  | {
      readonly kind: "usage-resume";
      readonly threadId: ThreadId;
      readonly payload: UsageResumePayload;
      readonly summary: string;
    };

/** What an orchestration event means for phone notifications, if anything. */
export function pushJobForEvent(event: OrchestrationEvent): Job | null {
  if (event.metadata?.historyImport === true) return null;
  if (event.type === "thread.activity-appended") {
    const { threadId, activity } = event.payload;
    if (activity.kind === USAGE_RESUME_ACTIVITY_KIND) {
      const payload = decodeUsageResumePayload(activity.payload);
      return Option.isSome(payload)
        ? { kind: "usage-resume", threadId, payload: payload.value, summary: activity.summary }
        : null;
    }
  }
  if (!shouldPublishAgentAwarenessEvent(event)) return null;
  const threadId = eventThreadId(event);
  return threadId === null ? null : { kind: "thread", threadId };
}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const sessions = yield* SessionStore.SessionStore;
  const sender = yield* ExpoPushSender;
  const config = yield* ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const file = path.join(config.stateDir, "push-devices.json");
  let devices: ReadonlyArray<PushDevice> = [];
  const tracks = new Map<string, ThreadTrack>();
  // Registrations, revocations and delivery cleanup all rewrite the file; one at a time.
  const lock = yield* Semaphore.make(1);

  const warn = (message: string) =>
    Effect.catchCause((cause: Cause.Cause<unknown>) =>
      Effect.logWarning(message, { cause: Cause.pretty(cause) }),
    );

  const persist = Effect.suspend(() =>
    writeFileStringAtomically({ filePath: file, contents: encodeDevices(devices) }),
  )
    .pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new PushNotificationError({ detail: `Could not save the push device: ${String(cause)}` }),
      ),
    );

  /** Applies `update` to the current list and saves it; false when nothing changed. */
  const replaceDevices = (
    update: (current: ReadonlyArray<PushDevice>) => ReadonlyArray<PushDevice>,
  ) =>
    lock.withPermits(1)(
      Effect.suspend(() => {
        const next = update(devices);
        if (next.length === devices.length && next.every((device, i) => device === devices[i])) {
          return Effect.succeed(false);
        }
        devices = next;
        if (devices.length === 0) tracks.clear();
        return persist.pipe(Effect.as(true));
      }),
    );

  /** Drops devices whose session is gone; keeps them all when sessions cannot be read. */
  const pruneRevoked = sessions.listActive().pipe(
    Effect.flatMap((active) =>
      replaceDevices((current) =>
        keepActivePushDevices(current, new Set(active.map((session) => session.sessionId))),
      ),
    ),
    Effect.asVoid,
    warn("failed to prune push devices of revoked sessions"),
  );

  const register: PushNotificationsShape["register"] = (sessionId, input) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((nowMs) =>
        replaceDevices((current) =>
          upsertPushDevice(current, {
            sessionId,
            token: input.token,
            platform: input.platform,
            categories: input.categories,
            updatedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          }),
        ),
      ),
      Effect.map((changed) => ({ changed })),
    );

  const unregister: PushNotificationsShape["unregister"] = (sessionId) =>
    replaceDevices((current) => current.filter((device) => device.sessionId !== sessionId)).pipe(
      Effect.map((changed) => ({ changed })),
    );

  const threadShell = (threadId: ThreadId) =>
    projections
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none<OrchestrationThreadShell>()));

  /** The top of an agent tree, for a child agent; null for a thread that has no lead. */
  const leadOf = Effect.fnUntraced(function* (thread: OrchestrationThreadShell) {
    let current = thread;
    for (let hop = 0; hop < MAX_LEAD_HOPS && current.parentThreadId; hop += 1) {
      const parent = yield* threadShell(current.parentThreadId);
      if (Option.isNone(parent)) break;
      current = parent.value;
    }
    return current.id === thread.id ? null : current;
  });

  const deliver = Effect.fnUntraced(function* (
    environmentId: EnvironmentId,
    thread: OrchestrationThreadShell,
    kind: PushEventKind,
    payload: UsageResumePayload | null,
  ) {
    yield* pruneRevoked;
    const recipients = pushRecipients(devices, PUSH_EVENT_CATEGORY[kind]);
    if (recipients.length === 0) return;
    const lead = yield* leadOf(thread);
    const nowMs = yield* Clock.currentTimeMillis;
    const { title, body } = formatPushNotification({
      kind,
      threadTitle: thread.title,
      leadTitle: lead?.title ?? null,
      payload,
      nowMs,
    });
    const deepLink = `/threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(thread.id)}`;
    const messages = recipients.map((device): ExpoPushMessage => ({
      to: device.token,
      title,
      body,
      data: { kind, environmentId, threadId: thread.id, deepLink },
      channelId: PUSH_ANDROID_CHANNEL,
      priority: "high",
      sound: "default",
    }));
    const tickets = yield* sender.send(messages);
    const gone = new Set(
      tickets.flatMap((ticket, index) =>
        ticket.deviceNotRegistered && recipients[index] ? [recipients[index].token] : [],
      ),
    );
    if (gone.size > 0) {
      yield* replaceDevices((current) => current.filter((device) => !gone.has(device.token)));
    }
  });

  const handle = Effect.fnUntraced(function* (job: Job) {
    if (job.kind === "revoked") {
      yield* replaceDevices((current) =>
        current.filter((device) => device.sessionId !== job.sessionId),
      );
      return;
    }
    if (devices.length === 0) return;
    const shell = yield* threadShell(job.threadId);
    if (Option.isNone(shell) || shell.value.archivedAt !== null) {
      tracks.delete(job.threadId);
      return;
    }
    const thread = shell.value;
    const environmentId = yield* environment.getEnvironmentId;
    const turnId = thread.latestTurn?.turnId ?? thread.session?.activeTurnId ?? null;
    const previous = tracks.get(job.threadId);
    if (job.kind === "usage-resume") {
      const decision = decideUsageResumeNotification(
        previous,
        { payload: job.payload, summary: job.summary, turnId },
        USAGE_RESUME_AUTO_SUMMARY,
      );
      tracks.set(job.threadId, decision.next);
      if (decision.kind) yield* deliver(environmentId, thread, decision.kind, job.payload);
      return;
    }
    const phase =
      projectThreadAwareness({ environmentId, project: { title: "" }, thread })?.phase ?? null;
    const decision = decideThreadNotification(previous, {
      phase,
      turnId,
      turnState: thread.latestTurn?.state ?? null,
      lastError: thread.session?.lastError ?? null,
    });
    tracks.set(job.threadId, decision.next);
    if (decision.kind) yield* deliver(environmentId, thread, decision.kind, null);
  });

  const worker = yield* makeDrainableWorker((job: Job) =>
    handle(job).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("push notification failed", {
          job: job.kind,
          cause: Cause.pretty(cause),
        }),
      ),
    ),
  );

  const load = fileSystem.readFileString(file).pipe(
    Effect.map((text) => Option.getOrElse(decodeDevices(text), () => [])),
    Effect.orElseSucceed((): ReadonlyArray<PushDevice> => []),
    Effect.tap((loaded) =>
      Effect.sync(() => {
        devices = loaded;
      }),
    ),
  );

  const start: PushNotificationsShape["start"] = Effect.fn("PushNotifications.start")(function* () {
    yield* load;
    yield* pruneRevoked;
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(
      Effect.all(
        [
          Stream.runForEach(events, (event) => {
            const job = pushJobForEvent(event);
            return job === null ? Effect.void : worker.enqueue(job);
          }),
          // Through the worker, so a revocation is ordered with deliveries.
          Stream.runForEach(sessions.streamChanges, (change) =>
            change.type === "clientRemoved"
              ? worker.enqueue({ kind: "revoked", sessionId: change.sessionId })
              : Effect.void,
          ),
        ],
        { concurrency: "unbounded", discard: true },
      ),
    );
  });

  return PushNotifications.of({ register, unregister, start, drain: worker.drain });
});

export const layer = Layer.effect(PushNotifications, make);
export const layerLive = layer.pipe(Layer.provide(expoPushSenderLayer));
