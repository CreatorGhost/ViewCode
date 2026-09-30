import {
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ThreadId,
  USAGE_RESUME_ACTIVITY_KIND,
  type UsageResumePayload,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { ServerConfig } from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import * as DesktopTelemetryReceiver from "../resourceTelemetry/DesktopTelemetryReceiver.ts";
import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AgentMessaging } from "./AgentMessaging.ts";
import {
  USAGE_RESUME_DELAY_MS,
  TRANSIENT_RETRY_DELAYS_MS,
  USAGE_RESUME_BUSY_RETRY_MS,
  USAGE_RESUME_STARTUP_GRACE_MS,
  UsageResume,
  layer,
} from "./UsageResume.ts";
import { parseResetTime } from "./usageResetTime.ts";

const THREAD = ThreadId.make("thread-1");
const LIMIT_TEXT = "You've hit your limit";

let counter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => {
    counter += 1;
    const bytes = new Uint8Array(size);
    new DataView(bytes.buffer).setUint32(0, counter);
    return bytes;
  },
  digest: (_algorithm, data) => Effect.succeed(data),
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const HOUR = 3_600_000;

interface Window {
  readonly id: string;
  readonly kind: "session";
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string;
}

const makeHarness = (
  stateDir: string,
  settings: { resumeAfterUsageLimit?: boolean; keepAwakeForUsageResume?: boolean } = {},
) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const activities = yield* Ref.make<ReadonlyArray<UsageResumePayload>>([]);
    const continues = yield* Queue.unbounded<{
      threadId: string;
      messageId: string;
      reason: "usage" | "transient";
    }>();
    /** What AgentMessaging answers when asked to continue the thread. */
    const outcome = yield* Ref.make<"started" | "busy" | "paused" | "gone">("started");
    const summaries = yield* Ref.make<ReadonlyArray<string>>([]);
    /** Every state recorded and every keep-awake change, in order, to wait on. */
    const noted = yield* Queue.unbounded<UsageResumePayload>();
    const awakeChanges = yield* Queue.unbounded<boolean>();
    const awake = yield* Ref.make<ReadonlyArray<boolean>>([]);
    const windows = yield* Ref.make<ReadonlyArray<Window>>([]);
    const parent = yield* Ref.make<string | null>(null);
    /** What the service published to the control stream, in order (null clears). */
    const published = yield* Ref.make<ReadonlyArray<{ resumeAt?: string } | null>>([]);
    const publish = (event: unknown) => PubSub.publish(events, event as OrchestrationEvent);

    const shell = {
      id: THREAD,
      archivedAt: null,
      parentThreadId: null,
      modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
      session: { status: "error", providerInstanceId: "claudeAgent", lastError: LIMIT_TEXT },
    } as unknown as OrchestrationThreadShell;

    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Ref.get(parent).pipe(
            Effect.map((parentThreadId) => ({
              snapshotSequence: 1,
              projects: [],
              threads: [{ ...shell, parentThreadId } as OrchestrationThreadShell],
              updatedAt: "2026-01-01T00:00:00.000Z",
            })),
          ),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === USAGE_RESUME_ACTIVITY_KIND
            ? Ref.update(activities, (all) => [
                ...all,
                command.activity.payload as UsageResumePayload,
              ]).pipe(
                Effect.andThen(Ref.update(summaries, (all) => [...all, command.activity.summary])),
                Effect.andThen(Queue.offer(noted, command.activity.payload as UsageResumePayload)),
                Effect.as({ sequence: 1 }),
              )
            : Effect.succeed({ sequence: 1 }),
        subscribeDomainEvents: PubSub.subscribe(events).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      }),
      Layer.mock(ProviderRegistry)({
        // A fresh reading: the service ignores stale ones.
        getProviders: Effect.all([Ref.get(windows), Clock.currentTimeMillis]).pipe(
          Effect.map(
            ([all, nowMs]) =>
              [
                { instanceId: "claudeAgent", usageLimits: { checkedAt: iso(nowMs), windows: all } },
              ] as never,
          ),
        ),
      }),
      Layer.mock(AgentMessaging)({
        continueAfterLimit: (threadId, messageId, reason) =>
          Ref.get(outcome).pipe(
            Effect.tap((result) =>
              result === "started"
                ? Queue.offer(continues, { threadId, messageId, reason })
                : Effect.void,
            ),
          ),
        setUsageResume: (_threadId, state) => Ref.update(published, (all) => [...all, state]),
      }),
      ServerSettingsService.layerTest(settings),
      DesktopTelemetryReceiver.layerTest({
        setKeepAwake: (enabled) =>
          Ref.update(awake, (all) => [...all, enabled]).pipe(
            Effect.andThen(Queue.offer(awakeChanges, enabled)),
          ),
      }),
      Layer.succeed(ServerConfig, { stateDir } as never),
      Layer.succeed(ServerActivation, undefined),
      Layer.succeed(Crypto.Crypto, testCrypto),
      NodeServices.layer,
    );

    const states = Ref.get(activities).pipe(Effect.map((all) => all.map((entry) => entry.state)));
    return {
      publish,
      windows,
      parent,
      published,
      continues,
      outcome,
      summaries,
      states,
      activities,
      awake: Ref.get(awake),
      /** Waits for the next recorded state that matches, skipping earlier ones. */
      awaitNote: (matches: (payload: UsageResumePayload) => boolean) =>
        Effect.gen(function* () {
          while (true) {
            const payload = yield* Queue.take(noted);
            if (matches(payload)) return payload;
          }
        }),
      /** Waits for the desktop to be told to hold (true) or release (false) keep-awake. */
      awaitAwake: (enabled: boolean) =>
        Effect.gen(function* () {
          while ((yield* Queue.take(awakeChanges)) !== enabled) {
            // earlier changes
          }
        }),
      /** The thread's turn ends with an error, or a limit error if none is given. */
      fail: (lastError = LIMIT_TEXT) =>
        publish({
          type: "thread.session-set",
          payload: { threadId: THREAD, session: { status: "error", lastError } },
        }),
      /** The session reports idle after the turn, as Claude's CLI does after a result. */
      idle: (lastError: string | null) =>
        publish({
          type: "thread.session-set",
          payload: { threadId: THREAD, session: { status: "ready", lastError } },
        }),
      /** The provider reports a rejected usage window during the turn. */
      rejected: (info: unknown) =>
        publish({
          type: "thread.activity-appended",
          payload: {
            threadId: THREAD,
            activity: { kind: "runtime.warning", payload: { message: "limit", detail: info } },
          },
        }),
      /** The engine reports a turn start, as it does for the user's prompt or for our resume. */
      turnStart: (messageId: string) =>
        publish({
          type: "thread.turn-start-requested",
          payload: { threadId: THREAD, messageId },
        }),
      layer: layer.pipe(Layer.provide(dependencies)),
    };
  });

type Harness = Effect.Success<ReturnType<typeof makeHarness>>;

/** Runs `body` against a started UsageResume; `settle` waits for events to be handled. */
const withResume = <A, E, R = never>(
  stateDir: string,
  settings: Parameters<typeof makeHarness>[1],
  body: (
    harness: Harness,
    resume: UsageResume["Service"],
    settle: Effect.Effect<void>,
  ) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(stateDir, settings);
      return yield* Effect.gen(function* () {
        const resume = yield* UsageResume;
        yield* resume.start();
        const settle = Effect.yieldNow.pipe(
          Effect.andThen(resume.drain),
          Effect.andThen(Effect.yieldNow),
        );
        return yield* body(harness, resume, settle);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

const scoped = <A, E>(
  body: (
    stateDir: string,
    files: string[],
  ) => Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const stateDir = yield* fs.makeTempDirectoryScoped({ prefix: "usage-resume-" });
    return yield* body(stateDir, [path.join(stateDir, "usage-resume", "thread-1.json")]);
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped);

const exists = (file: string) =>
  FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.exists(file)));

const fiveHourWindow = (resetsAtMs: number): Window => ({
  id: "five_hour",
  kind: "session",
  label: "5-hour",
  usedPercent: 100,
  resetsAt: iso(resetsAtMs),
});

describe("UsageResume", () => {
  it.effect(
    "schedules from the usage window, resumes a minute after the reset, and holds the computer awake meanwhile",
    () =>
      scoped((stateDir, [file]) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.fail();
            yield* settle;

            const scheduled = (yield* Ref.get(harness.activities))[0];
            assert.equal(scheduled?.state, "scheduled");
            assert.equal(scheduled?.resumeAt, iso(HOUR + USAGE_RESUME_DELAY_MS));
            assert.isTrue(yield* exists(file!));
            assert.deepEqual(yield* harness.awake, [true]);

            yield* TestClock.adjust(Duration.millis(HOUR));
            yield* settle;
            assert.equal(yield* Queue.size(harness.continues), 0);

            yield* TestClock.adjust(Duration.millis(USAGE_RESUME_DELAY_MS));
            const started = yield* Queue.take(harness.continues);
            assert.equal(started.threadId, THREAD);
            yield* harness.awaitAwake(false);

            assert.deepEqual(yield* harness.states, ["scheduled", "resumed"]);
            assert.isFalse(yield* exists(file!));
            assert.deepEqual(yield* harness.awake, [true, false]);
          }),
        ),
      ),
  );

  it.effect("falls back to the reset time in the error text", () =>
    scoped((stateDir) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          // The test clock starts at 1970-01-01T00:00Z, so 8pm is 20 hours away.
          yield* harness.fail(`${LIMIT_TEXT} · resets 8pm (UTC)`);
          yield* settle;
          const scheduled = (yield* Ref.get(harness.activities))[0];
          assert.equal(scheduled?.resumeAt, iso(20 * HOUR + USAGE_RESUME_DELAY_MS));

          yield* TestClock.adjust(Duration.millis(20 * HOUR + USAGE_RESUME_DELAY_MS));
          yield* Queue.take(harness.continues);
        }),
      ),
    ),
  );

  it.effect("says so and schedules nothing when the reset time is unknown", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* harness.states, ["unknown"]);
          assert.isFalse(yield* exists(file!));
          assert.deepEqual(yield* harness.awake, []);
        }),
      ),
    ),
  );

  it.effect("shows the reset time without scheduling when automatic resume is off", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, { resumeAfterUsageLimit: false }, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* harness.states, ["reset-known"]);
          assert.isFalse(yield* exists(file!));

          yield* TestClock.adjust(Duration.millis(2 * HOUR));
          yield* settle;
          assert.equal(yield* Queue.size(harness.continues), 0);
        }),
      ),
    ),
  );

  it.effect("does not ask the desktop to stay awake when that setting is off", () =>
    scoped((stateDir) =>
      withResume(stateDir, { keepAwakeForUsageResume: false }, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* harness.states, ["scheduled"]);
          assert.deepEqual(yield* harness.awake, []);
        }),
      ),
    ),
  );

  it.effect("drops the schedule when the user sends a message", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;

          yield* harness.turnStart("user-message");
          yield* settle;
          assert.deepEqual(yield* harness.states, ["scheduled", "cancelled"]);
          assert.isFalse(yield* exists(file!));
          assert.deepEqual(yield* harness.awake, [true, false]);

          yield* TestClock.adjust(Duration.millis(2 * HOUR));
          yield* settle;
          assert.equal(yield* Queue.size(harness.continues), 0);
        }),
      ),
    ),
  );

  it.effect("drops the schedule on Cancel and on a model switch", () =>
    scoped((stateDir) =>
      withResume(stateDir, {}, (harness, resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          assert.isTrue(yield* resume.cancel(THREAD));
          assert.isFalse(yield* resume.cancel(THREAD));

          // A new turn fails: a different failure, decided afresh.
          yield* harness.turnStart("user-message-2");
          yield* harness.fail(`${LIMIT_TEXT} again`);
          yield* settle;
          yield* harness.publish({
            type: "thread.meta-updated",
            payload: { threadId: THREAD, modelSelection: { instanceId: "codex", model: "gpt" } },
          });
          yield* settle;
          assert.deepEqual(yield* harness.states, [
            "scheduled",
            "cancelled",
            "scheduled",
            "cancelled",
          ]);

          yield* TestClock.adjust(Duration.millis(2 * HOUR));
          yield* settle;
          assert.equal(yield* Queue.size(harness.continues), 0);
        }),
      ),
    ),
  );

  it.effect("resumes immediately on Resume now, even with nothing scheduled", () =>
    scoped((stateDir) =>
      withResume(stateDir, {}, (harness, resume, settle) =>
        Effect.gen(function* () {
          yield* harness.fail();
          yield* settle;
          assert.isTrue(yield* resume.resumeNow(THREAD));
          const started = yield* Queue.take(harness.continues);
          assert.equal(started.threadId, THREAD);
          assert.equal(started.reason, "usage");
          assert.equal((yield* Ref.get(harness.summaries)).at(-1), "Resumed by you.");
        }),
      ),
    ),
  );

  it.effect("re-arms from disk after a restart", () =>
    scoped((stateDir, [file]) =>
      Effect.gen(function* () {
        yield* withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.fail();
            yield* settle;
          }),
        );
        assert.isTrue(yield* exists(file!));

        yield* withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            assert.deepEqual(yield* harness.awake, [true]);
            yield* TestClock.adjust(Duration.millis(HOUR));
            yield* settle;
            assert.equal(yield* Queue.size(harness.continues), 0);
            yield* TestClock.adjust(Duration.millis(USAGE_RESUME_DELAY_MS));
            yield* Queue.take(harness.continues);
          }),
        );
      }),
    ),
  );

  it.effect("runs an overdue schedule shortly after startup", () =>
    scoped((stateDir) =>
      Effect.gen(function* () {
        yield* withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.fail();
            yield* settle;
          }),
        );
        // The server was down past the resume time.
        yield* TestClock.adjust(Duration.millis(3 * HOUR));

        yield* withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* settle;
            assert.equal(yield* Queue.size(harness.continues), 0);
            yield* TestClock.adjust(Duration.millis(USAGE_RESUME_STARTUP_GRACE_MS));
            const started = yield* Queue.take(harness.continues);
            assert.equal(started.threadId, THREAD);
          }),
        );
      }),
    ),
  );

  it.effect("reschedules once from the fresh reset time, then stops", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;

          yield* TestClock.adjust(Duration.millis(HOUR + USAGE_RESUME_DELAY_MS));
          const first = yield* Queue.take(harness.continues);
          yield* harness.turnStart(first.messageId);
          // The provider still refuses, with a later reset.
          const secondReset = 6 * HOUR;
          yield* Ref.set(harness.windows, [fiveHourWindow(secondReset)]);
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* harness.states, ["scheduled", "resumed", "scheduled"]);

          yield* TestClock.adjust(Duration.millis(secondReset + USAGE_RESUME_DELAY_MS));
          const second = yield* Queue.take(harness.continues);
          yield* harness.turnStart(second.messageId);
          const thirdReset = 12 * HOUR;
          yield* Ref.set(harness.windows, [fiveHourWindow(thirdReset)]);
          yield* harness.fail();
          yield* settle;

          assert.deepEqual(yield* harness.states, [
            "scheduled",
            "resumed",
            "scheduled",
            "resumed",
            "gave-up",
          ]);
          assert.isFalse(yield* exists(file!));
          assert.deepEqual(yield* harness.awake, [true, false, true, false]);

          yield* TestClock.adjust(Duration.millis(24 * HOUR));
          yield* settle;
          assert.equal(yield* Queue.size(harness.continues), 0);
        }),
      ),
    ),
  );

  describe("where the reset time comes from", () => {
    const firstActivity = (harness: Harness) =>
      Ref.get(harness.activities).pipe(Effect.map((all) => all[0]));

    it.effect("uses the provider's signal from the turn before the error text or the windows", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.rejected({ status: "rejected", resetsAt: 3 * 3600 });
            yield* harness.fail(`${LIMIT_TEXT} · resets 8pm (UTC)`);
            yield* settle;
            const scheduled = yield* firstActivity(harness);
            assert.equal(scheduled?.resetsAt, iso(3 * HOUR));
            assert.equal(scheduled?.resumeAt, iso(3 * HOUR + USAGE_RESUME_DELAY_MS));
          }),
        ),
      ),
    );

    it.effect("lets a later signal with a time beat an earlier one without", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* harness.rejected({ status: "rejected" });
            yield* harness.rejected({ status: "rejected", resetsAtSeconds: 2 * 3600 });
            // A signal without a time afterwards does not erase it.
            yield* harness.rejected({ status: "rejected" });
            yield* harness.fail();
            yield* settle;
            assert.equal((yield* firstActivity(harness))?.resetsAt, iso(2 * HOUR));
          }),
        ),
      ),
    );

    it.effect("forgets the signal when a new turn starts", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* harness.rejected({ status: "rejected", resetsAt: 3 * 3600 });
            yield* harness.turnStart("user-message");
            yield* harness.fail(`${LIMIT_TEXT} · resets 8pm (UTC)`);
            yield* settle;
            assert.equal((yield* firstActivity(harness))?.resetsAt, iso(20 * HOUR));
          }),
        ),
      ),
    );

    it.effect("reads a usage window only when it is at least 95% used", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [{ ...fiveHourWindow(HOUR), usedPercent: 94 }]);
            yield* harness.fail();
            yield* settle;
            assert.deepEqual(yield* harness.states, ["unknown"]);

            yield* Ref.set(harness.windows, [{ ...fiveHourWindow(HOUR), usedPercent: 96 }]);
            // A new turn fails: a different failure, decided afresh.
            yield* harness.turnStart("user-message-2");
            yield* harness.fail(`${LIMIT_TEXT} again`);
            yield* settle;
            assert.deepEqual(yield* harness.states, ["unknown", "scheduled"]);
          }),
        ),
      ),
    );

    it.effect("never resumes from a reset that has already passed", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.millis(10 * HOUR));
            // The provider's reset is already an hour past, and nothing else names one.
            yield* harness.rejected({ status: "rejected", resetsAt: 9 * 3600 });
            yield* harness.fail();
            yield* settle;
            assert.deepEqual(yield* harness.states, ["unknown"]);
            yield* TestClock.adjust(Duration.millis(HOUR));
            yield* settle;
            assert.equal(yield* Queue.size(harness.continues), 0);
          }),
        ),
      ),
    );

    it.effect("falls through a past signal to the usage window the provider rejected", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* TestClock.adjust(Duration.millis(10 * HOUR));
            yield* Ref.set(harness.windows, [
              fiveHourWindow(12 * HOUR),
              { ...fiveHourWindow(40 * HOUR), id: "seven_day", usedPercent: 80 },
            ]);
            yield* harness.rejected({
              status: "rejected",
              rateLimitType: "seven_day",
              resetsAt: 9 * 3600,
            });
            yield* harness.fail();
            yield* settle;
            assert.equal((yield* firstActivity(harness))?.resetsAt, iso(40 * HOUR));
          }),
        ),
      ),
    );
  });

  describe("a real usage limit still resumes by itself", () => {
    it.effect("from Claude's rejected rate-limit signal with a future reset", () =>
      scoped((stateDir, [file]) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* harness.turnStart("user-message");
            yield* harness.rejected({
              status: "rejected",
              rateLimitType: "five_hour",
              resetsAt: 3 * 3600,
            });
            // What the Claude adapter reports once a window was rejected.
            yield* harness.fail(
              "Claude usage limit reached. Send the message again once the limit resets.",
            );
            yield* harness.idle(
              "Claude usage limit reached. Send the message again once the limit resets.",
            );
            yield* settle;
            const scheduled = (yield* Ref.get(harness.activities))[0];
            assert.equal(scheduled?.state, "scheduled");
            assert.equal(scheduled?.resumeAt, iso(3 * HOUR + USAGE_RESUME_DELAY_MS));
            assert.isTrue(yield* exists(file!));

            yield* TestClock.adjust(Duration.millis(3 * HOUR + USAGE_RESUME_DELAY_MS));
            const started = yield* Queue.take(harness.continues);
            assert.equal(started.reason, "usage");
            yield* harness.awaitNote((payload) => payload.state === "resumed");
            assert.equal(
              (yield* Ref.get(harness.summaries)).at(-1),
              "Trying to continue after the usage limit…",
            );
          }),
        ),
      ),
    );

    it.effect("from the error text '5-hour limit reached ∙ resets 3pm' with 3pm ahead", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            const text = "5-hour limit reached ∙ resets 3pm";
            const resetsAt = parseResetTime(text, yield* Clock.currentTimeMillis)!;
            assert.isAbove(resetsAt, yield* Clock.currentTimeMillis);
            yield* harness.fail(text);
            yield* settle;
            const scheduled = (yield* Ref.get(harness.activities))[0];
            assert.equal(scheduled?.state, "scheduled");
            assert.equal(scheduled?.resumeAt, iso(resetsAt + USAGE_RESUME_DELAY_MS));

            yield* TestClock.adjust(Duration.millis(resetsAt + USAGE_RESUME_DELAY_MS));
            const started = yield* Queue.take(harness.continues);
            assert.equal(started.reason, "usage");
          }),
        ),
      ),
    );
  });

  describe("one decision per failure", () => {
    it.effect(
      "does not turn 'unknown' into a schedule from a later event of the same failure",
      () =>
        scoped((stateDir, [file]) =>
          withResume(stateDir, {}, (harness, _resume, settle) =>
            Effect.gen(function* () {
              yield* harness.turnStart("user-message");
              yield* harness.fail();
              yield* settle;
              // Claude also reports the failure as the turn's end and a later idle.
              yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
              yield* harness.fail();
              yield* harness.idle(LIMIT_TEXT);
              yield* settle;
              assert.deepEqual(yield* harness.states, ["unknown"]);
              assert.isFalse(yield* exists(file!));
            }),
          ),
        ),
    );

    it.effect("keeps a schedule and the control state through the idle after the failure", () =>
      scoped((stateDir, [file]) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.fail();
            yield* settle;
            yield* harness.idle(LIMIT_TEXT);
            // Even an idle that lost the error does not undo a pending resume.
            yield* harness.idle(null);
            yield* settle;
            assert.deepEqual(yield* harness.states, ["scheduled"]);
            assert.deepEqual(yield* Ref.get(harness.published), [
              { resumeAt: iso(HOUR + USAGE_RESUME_DELAY_MS) },
            ]);
            assert.isTrue(yield* exists(file!));
          }),
        ),
      ),
    );
  });

  describe("a transient throttle", () => {
    const PROXY_TEXT =
      "API Error: Server is temporarily limiting requests (not your usage limit) · litellm.RateLimitError: rate_limit_error. Please try again later";

    it.effect("retries after 10s, 30s and 60s with a plain continue, then stops", () =>
      scoped((stateDir, [file]) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            let request = "user-message";
            for (const delay of TRANSIENT_RETRY_DELAYS_MS) {
              yield* harness.turnStart(request);
              yield* harness.fail(PROXY_TEXT);
              yield* settle;
              const latest = yield* harness.awaitNote(
                (payload) => payload.state === "rate-limited",
              );
              assert.equal(latest?.state, "rate-limited");
              assert.equal(latest?.resumeAt, iso((yield* Clock.currentTimeMillis) + delay));
              yield* TestClock.adjust(Duration.millis(delay));
              const retried = yield* Queue.take(harness.continues);
              assert.equal(retried.reason, "transient");
              request = retried.messageId;
            }
            yield* harness.turnStart(request);
            yield* harness.fail(PROXY_TEXT);
            yield* settle;
            yield* harness.awaitNote((payload) => payload.state === "cancelled");
            assert.isFalse(yield* exists(file!));
            // Never reported as a usage limit on the control stream.
            assert.isTrue((yield* Ref.get(harness.published)).every((state) => state === null));
            yield* TestClock.adjust(Duration.millis(HOUR));
            yield* settle;
            assert.equal(yield* Queue.size(harness.continues), 0);
          }),
        ),
      ),
    );

    it.effect("waits for a short retry hint instead of reading it as a usage reset", () =>
      scoped((stateDir) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* harness.fail("Rate limit reached for gpt-5. Please try again in 45s.");
            yield* settle;
            const latest = (yield* Ref.get(harness.activities)).at(-1);
            assert.equal(latest?.state, "rate-limited");
            assert.equal(latest?.resumeAt, iso(45_000));
          }),
        ),
      ),
    );
  });

  describe("when the resume is due", () => {
    it.effect("waits a minute when the thread is busy, instead of dropping the resume", () =>
      scoped((stateDir, [file]) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.fail();
            yield* settle;
            yield* Ref.set(harness.outcome, "busy");
            yield* TestClock.adjust(Duration.millis(HOUR + USAGE_RESUME_DELAY_MS));
            const later = HOUR + USAGE_RESUME_DELAY_MS + USAGE_RESUME_BUSY_RETRY_MS;
            const latest = yield* harness.awaitNote((payload) => payload.resumeAt === iso(later));
            assert.equal(latest.state, "scheduled");
            assert.deepEqual((yield* Ref.get(harness.published)).at(-1), { resumeAt: iso(later) });
            assert.isTrue(yield* exists(file!));

            yield* Ref.set(harness.outcome, "started");
            yield* TestClock.adjust(Duration.millis(USAGE_RESUME_BUSY_RETRY_MS));
            yield* Queue.take(harness.continues);
            yield* harness.awaitNote((payload) => payload.state === "resumed");
            assert.equal(
              (yield* Ref.get(harness.summaries)).at(-1),
              "Trying to continue after the usage limit…",
            );
          }),
        ),
      ),
    );

    it.effect("cancels, saying so, when the user has the agent stopped", () =>
      scoped((stateDir, [file]) =>
        withResume(stateDir, {}, (harness, _resume, settle) =>
          Effect.gen(function* () {
            yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
            yield* harness.fail();
            yield* settle;
            yield* Ref.set(harness.outcome, "paused");
            yield* TestClock.adjust(Duration.millis(HOUR + USAGE_RESUME_DELAY_MS));
            yield* harness.awaitNote((payload) => payload.state === "cancelled");
            assert.deepEqual(yield* harness.states, ["scheduled", "cancelled"]);
            assert.isFalse(yield* exists(file!));
            assert.deepEqual(yield* harness.awake, [true, false]);
          }),
        ),
      ),
    );
  });

  it.effect("drops the schedule and releases keep-awake when the thread is archived", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          yield* harness.publish({ type: "thread.archived", payload: { threadId: THREAD } });
          yield* settle;
          assert.isFalse(yield* exists(file!));
          assert.deepEqual(yield* harness.awake, [true, false]);
          assert.deepEqual((yield* Ref.get(harness.published)).at(-1), null);
          yield* TestClock.adjust(Duration.millis(2 * HOUR));
          yield* settle;
          assert.equal(yield* Queue.size(harness.continues), 0);
        }),
      ),
    ),
  );

  it.effect("drops a due resume for a thread archived since, without running it", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          // AgentMessaging answers "gone" for an archived thread.
          yield* Ref.set(harness.outcome, "gone");
          yield* TestClock.adjust(Duration.millis(HOUR + USAGE_RESUME_DELAY_MS));
          yield* harness.awaitAwake(false);
          assert.isFalse(yield* exists(file!));
          assert.deepEqual(yield* harness.awake, [true, false]);
          assert.deepEqual(yield* harness.states, ["scheduled"]);
        }),
      ),
    ),
  );

  it.effect("leaves a child agent to its lead: shows the reset, schedules nothing", () =>
    scoped((stateDir, [file]) =>
      withResume(stateDir, {}, (harness, resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.parent, "lead");
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* harness.states, ["reset-known"]);
          assert.isFalse(yield* exists(file!));
          assert.deepEqual(yield* harness.awake, []);
          assert.deepEqual(yield* Ref.get(harness.published), []);

          yield* TestClock.adjust(Duration.millis(2 * HOUR));
          yield* settle;
          assert.equal(yield* Queue.size(harness.continues), 0);
          // The user can still continue it by hand.
          assert.isTrue(yield* resume.resumeNow(THREAD));
        }),
      ),
    ),
  );

  it.effect("tells the control stream when a resume is scheduled and clears it on resume", () =>
    scoped((stateDir) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* Ref.set(harness.windows, [fiveHourWindow(HOUR)]);
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* Ref.get(harness.published), [
            { resumeAt: iso(HOUR + USAGE_RESUME_DELAY_MS) },
          ]);
          yield* TestClock.adjust(Duration.millis(HOUR + USAGE_RESUME_DELAY_MS));
          yield* Queue.take(harness.continues);
          assert.deepEqual((yield* Ref.get(harness.published)).at(-1), null);
        }),
      ),
    ),
  );

  it.effect("tells the control stream a limit with no time needs the user", () =>
    scoped((stateDir) =>
      withResume(stateDir, {}, (harness, _resume, settle) =>
        Effect.gen(function* () {
          yield* harness.fail();
          yield* settle;
          assert.deepEqual(yield* Ref.get(harness.published), [{}]);
        }),
      ),
    ),
  );
});
