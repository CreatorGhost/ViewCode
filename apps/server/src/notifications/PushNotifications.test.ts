import {
  AuthSessionId,
  EnvironmentId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type PushNotificationCategories,
  type PushRegisterInput,
  USAGE_RESUME_ACTIVITY_KIND,
  type UsageResumePayload,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { USAGE_RESUME_AUTO_SUMMARY } from "../agents/UsageResume.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import { ServerConfig } from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerActivation } from "../serverActivation.ts";
import {
  type ExpoPushMessage,
  type ExpoPushTicket,
  ExpoPushSender,
  PushNotifications,
  layer,
} from "./PushNotifications.ts";

const ENVIRONMENT = EnvironmentId.make("env-1");
const PHONE = AuthSessionId.make("session-phone");
const TABLET = AuthSessionId.make("session-tablet");
const ALL: PushNotificationCategories = {
  finished: true,
  needsYou: true,
  usageLimit: true,
  resumed: true,
};
const TOKEN = "ExponentPushToken[phone-token-1]";
const LIMIT_TEXT = "You've hit your limit";

const registration = (
  categories: PushNotificationCategories = ALL,
  token = TOKEN,
): PushRegisterInput => ({ token, platform: "android", categories });

type ShellState = {
  readonly title?: string;
  readonly parentThreadId?: string | null;
  readonly kind?: "sidechat";
  readonly status?: "running" | "ready" | "error" | "starting" | null;
  readonly turnId?: string | null;
  readonly turnState?: "running" | "completed" | "error" | "interrupted";
  readonly lastError?: string | null;
  readonly approval?: boolean;
  readonly input?: boolean;
  readonly archived?: boolean;
};

const shellOf = (id: string, state: ShellState): OrchestrationThreadShell =>
  ({
    id,
    projectId: "project-1",
    title: state.title ?? `Thread ${id}`,
    modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
    parentThreadId: state.parentThreadId ?? null,
    ...(state.kind ? { kind: state.kind } : {}),
    archivedAt: state.archived ? "2026-01-01T00:00:00.000Z" : null,
    updatedAt: "2026-01-01T00:00:00.000Z",
    hasPendingApprovals: state.approval ?? false,
    hasPendingUserInput: state.input ?? false,
    latestTurn:
      state.turnId === undefined || state.turnId === null
        ? null
        : {
            turnId: state.turnId,
            state: state.turnState ?? "running",
            requestedAt: "2026-01-01T00:00:00.000Z",
            startedAt: null,
            completedAt: null,
            assistantMessageId: null,
          },
    session:
      state.status === null || state.status === undefined
        ? null
        : {
            threadId: id,
            status: state.status,
            providerName: null,
            activeTurnId: null,
            lastError: state.lastError ?? null,
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
  }) as unknown as OrchestrationThreadShell;

const makeHarness = (stateDir: string) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const sessionChanges = yield* PubSub.unbounded<SessionStore.SessionCredentialChange>();
    const shells = yield* Ref.make(new Map<string, OrchestrationThreadShell>());
    const active = yield* Ref.make<ReadonlySet<string>>(new Set([PHONE, TABLET]));
    const sent = yield* Ref.make<ReadonlyArray<ExpoPushMessage>>([]);
    const tickets = yield* Ref.make<ReadonlyArray<ExpoPushTicket> | null>(null);

    const dependencies = Layer.mergeAll(
      Layer.mock(OrchestrationEngineService)({
        subscribeDomainEvents: PubSub.subscribe(events).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Ref.get(shells).pipe(Effect.map((all) => Option.fromNullishOr(all.get(threadId)))),
      }),
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(ENVIRONMENT),
      }),
      Layer.mock(SessionStore.SessionStore)({
        cookieName: "session",
        legacyCookieName: undefined,
        listActive: () =>
          Ref.get(active).pipe(
            Effect.map((ids) => [...ids].map((sessionId) => ({ sessionId }) as never)),
          ),
        streamChanges: Stream.fromPubSub(sessionChanges),
      }),
      Layer.mock(ExpoPushSender)({
        send: (messages) =>
          Ref.update(sent, (all) => [...all, ...messages]).pipe(
            Effect.andThen(Ref.get(tickets)),
            Effect.map(
              (answer) => answer ?? messages.map(() => ({ ok: true, deviceNotRegistered: false })),
            ),
          ),
      }),
      Layer.succeed(ServerConfig, { stateDir } as never),
      Layer.succeed(ServerActivation, undefined),
      NodeServices.layer,
    );

    const publish = (event: unknown) => PubSub.publish(events, event as OrchestrationEvent);
    return {
      sent,
      tickets,
      active,
      /** Sets the thread's shell, then reports a session change for it. */
      set: (threadId: string, state: ShellState) =>
        Ref.update(shells, (all) => new Map(all).set(threadId, shellOf(threadId, state))).pipe(
          Effect.andThen(
            publish({
              type: "thread.session-set",
              metadata: {},
              payload: { threadId, session: {} },
            }),
          ),
          Effect.asVoid,
        ),
      usageResume: (threadId: string, payload: UsageResumePayload, summary = "Out of usage.") =>
        publish({
          type: "thread.activity-appended",
          metadata: {},
          payload: {
            threadId,
            activity: { kind: USAGE_RESUME_ACTIVITY_KIND, payload, summary },
          },
        }).pipe(Effect.asVoid),
      revoke: (sessionId: AuthSessionId) =>
        PubSub.publish(sessionChanges, { type: "clientRemoved", sessionId }),
      layer: layer.pipe(Layer.provide(dependencies)),
    };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

const withPush = <A, E>(
  body: (
    harness: Harness,
    push: PushNotifications["Service"],
    settle: Effect.Effect<void>,
    stateDir: string,
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "push-" });
    const harness = yield* makeHarness(stateDir);
    return yield* Effect.gen(function* () {
      const push = yield* PushNotifications;
      yield* push.start();
      const settle = Effect.yieldNow.pipe(
        Effect.andThen(push.drain),
        Effect.andThen(Effect.yieldNow),
      );
      // The service reads the thread's current shell, as the real projection does: let each
      // change be handled before the next one lands.
      const stepping: Harness = {
        ...harness,
        set: (threadId, state) => harness.set(threadId, state).pipe(Effect.andThen(settle)),
        usageResume: (threadId, payload, summary) =>
          harness.usageResume(threadId, payload, summary).pipe(Effect.andThen(settle)),
      };
      return yield* body(stepping, push, settle, stateDir);
    }).pipe(Effect.provide(harness.layer));
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

describe("PushNotifications", () => {
  it.effect("notifies once when a turn finishes, with the thread link and no message text", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration());
        yield* harness.set("t1", { title: "Fix login", status: "running", turnId: "turn-1" });
        yield* harness.set("t1", {
          title: "Fix login",
          status: "ready",
          turnId: "turn-1",
          turnState: "completed",
        });
        // A later event that leaves the thread settled on the same turn.
        yield* harness.set("t1", {
          title: "Fix login",
          status: "ready",
          turnId: "turn-1",
          turnState: "completed",
        });
        yield* settle;

        const sent = yield* Ref.get(harness.sent);
        assert.equal(sent.length, 1);
        assert.deepEqual(sent[0], {
          to: TOKEN,
          title: "Fix login",
          body: "Finished",
          data: {
            kind: "finished",
            environmentId: ENVIRONMENT,
            threadId: "t1",
            deepLink: "/threads/env-1/t1",
          },
          channelId: "agent-alerts",
          priority: "high",
          sound: "default",
        });
      }),
    ),
  );

  it.effect("stays quiet on the first sighting and for a session that boots ready", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration());
        yield* harness.set("t1", { status: "ready", turnId: "turn-1", turnState: "completed" });
        yield* harness.set("t2", { status: "starting" });
        yield* harness.set("t2", { status: "ready" });
        yield* settle;
        assert.equal((yield* Ref.get(harness.sent)).length, 0);
      }),
    ),
  );

  it.effect("tells the user when an agent needs an approval or an answer", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration());
        yield* harness.set("t1", { status: "running", turnId: "turn-1" });
        yield* harness.set("t1", { status: "running", turnId: "turn-1", approval: true });
        yield* harness.set("t1", { status: "running", turnId: "turn-1", approval: true });
        yield* harness.set("t1", { status: "running", turnId: "turn-1" });
        yield* harness.set("t1", { status: "running", turnId: "turn-1", input: true });
        yield* settle;
        assert.deepEqual(
          (yield* Ref.get(harness.sent)).map((message) => message.body),
          ["Needs your approval", "Has a question for you"],
        );
      }),
    ),
  );

  it.effect(
    "sends the usage limit instead of a failure, once per turn, then the automatic resume",
    () =>
      withPush((harness, push, settle) =>
        Effect.gen(function* () {
          yield* push.register(PHONE, registration());
          yield* harness.set("t1", { status: "running", turnId: "turn-1" });
          yield* harness.set("t1", {
            status: "error",
            turnId: "turn-1",
            turnState: "error",
            lastError: LIMIT_TEXT,
          });
          yield* harness.usageResume(
            "t1",
            {
              state: "scheduled",
              resetsAt: "2026-01-01T21:30:00.000Z",
              resumeAt: "2026-01-01T21:31:00.000Z",
            },
            "Out of usage; resumes automatically.",
          );
          // The thread was busy when the resume fell due: re-armed, same limit.
          yield* harness.usageResume("t1", {
            state: "scheduled",
            resetsAt: "2026-01-01T21:30:00.000Z",
            resumeAt: "2026-01-01T21:32:00.000Z",
          });
          yield* harness.usageResume("t1", { state: "resumed" }, USAGE_RESUME_AUTO_SUMMARY);
          yield* harness.usageResume("t1", { state: "resumed" }, "Resumed by you.");
          yield* settle;

          const sent = yield* Ref.get(harness.sent);
          assert.deepEqual(
            sent.map((message) => message.data.kind),
            ["usage-limit", "resumed"],
          );
          assert.match(sent[0]!.body, /^Usage limit reached\. Continuing /);
          assert.equal(sent[1]!.body, "Usage limit reset. Continuing the task.");
        }),
      ),
  );

  it.effect("reports an ordinary failure under finished", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration());
        yield* harness.set("t1", { status: "running", turnId: "turn-1" });
        yield* harness.set("t1", {
          status: "error",
          turnId: "turn-1",
          turnState: "error",
          lastError: "spawn ENOENT",
        });
        yield* settle;
        const sent = yield* Ref.get(harness.sent);
        assert.deepEqual(
          sent.map((message) => [message.data.kind, message.body]),
          [["failed", "Stopped with an error"]],
        );
      }),
    ),
  );

  it.effect("titles a child agent's notification with its lead and opens the child", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration());
        yield* harness.set("lead", { title: "Ship v2" });
        yield* harness.set("child", {
          title: "Write tests",
          parentThreadId: "lead",
          status: "running",
          turnId: "turn-c",
        });
        yield* harness.set("child", {
          title: "Write tests",
          parentThreadId: "lead",
          status: "ready",
          turnId: "turn-c",
          turnState: "completed",
        });
        yield* settle;
        const [message] = yield* Ref.get(harness.sent);
        assert.equal(message?.title, "Ship v2");
        assert.equal(message?.body, "Write tests: Finished");
        assert.equal(message?.data.threadId, "child");
      }),
    ),
  );

  it.effect("titles a side chat's notification as itself, not its parent", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration());
        yield* harness.set("main", { title: "Ship v2" });
        const side = { title: "Why this?", parentThreadId: "main", kind: "sidechat" } as const;
        yield* harness.set("side", { ...side, status: "running", turnId: "turn-s" });
        yield* harness.set("side", {
          ...side,
          status: "ready",
          turnId: "turn-s",
          turnState: "completed",
        });
        yield* settle;
        const [message] = yield* Ref.get(harness.sent);
        assert.equal(message?.title, "Why this?");
        assert.equal(message?.body, "Finished");
        assert.equal(message?.data.threadId, "side");
      }),
    ),
  );

  it.effect("honours the categories each phone turned off", () =>
    withPush((harness, push, settle) =>
      Effect.gen(function* () {
        yield* push.register(PHONE, registration({ ...ALL, finished: false }));
        yield* harness.set("t1", { status: "running", turnId: "turn-1" });
        yield* harness.set("t1", { status: "ready", turnId: "turn-1", turnState: "completed" });
        yield* harness.set("t1", { status: "running", turnId: "turn-2", approval: true });
        yield* settle;
        assert.deepEqual(
          (yield* Ref.get(harness.sent)).map((message) => message.data.kind),
          ["needs-approval"],
        );
      }),
    ),
  );

  it.effect(
    "keeps one registration per token and forgets revoked, expired and unregistered devices",
    () =>
      withPush((harness, push, settle, stateDir) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const file = path.join(stateDir, "push-devices.json");
          const saved = fs
            .readFileString(file)
            .pipe(
              Effect.map(
                (text) =>
                  (JSON.parse(text) as ReadonlyArray<{ sessionId: string }>).map(
                    (device) => device.sessionId,
                  ) as ReadonlyArray<string>,
              ),
            );
          const finishTurn = (turnId: string) =>
            harness
              .set("t1", { status: "running", turnId })
              .pipe(
                Effect.andThen(
                  harness.set("t1", { status: "ready", turnId, turnState: "completed" }),
                ),
                Effect.andThen(settle),
              );

          // The same phone paired again: the token moves to the new session.
          yield* push.register(PHONE, registration());
          yield* push.register(TABLET, registration());
          assert.deepEqual(yield* saved, [TABLET]);
          yield* finishTurn("turn-1");
          assert.equal((yield* Ref.get(harness.sent)).length, 1);

          // Revoking the session drops the device.
          yield* harness.revoke(TABLET);
          yield* settle;
          assert.deepEqual(yield* saved, []);

          // A session that expired without a revoke event is pruned before sending.
          yield* push.register(PHONE, registration());
          yield* Ref.set(harness.active, new Set([TABLET]));
          yield* finishTurn("turn-2");
          assert.equal((yield* Ref.get(harness.sent)).length, 1);
          assert.deepEqual(yield* saved, []);

          // Expo says the app was uninstalled.
          yield* Ref.set(harness.active, new Set([PHONE]));
          yield* push.register(PHONE, registration());
          yield* Ref.set(harness.tickets, [{ ok: false, deviceNotRegistered: true }]);
          yield* finishTurn("turn-3");
          assert.equal((yield* Ref.get(harness.sent)).length, 2);
          assert.deepEqual(yield* saved, []);

          yield* Ref.set(harness.tickets, null);
          yield* push.register(PHONE, registration());
          assert.deepEqual(yield* push.unregister(PHONE), { changed: true });
          assert.deepEqual(yield* push.unregister(PHONE), { changed: false });
          assert.deepEqual(yield* saved, []);
        }),
      ),
  );
});
