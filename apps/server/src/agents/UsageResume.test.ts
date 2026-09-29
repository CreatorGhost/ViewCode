import {
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  ThreadId,
  USAGE_RESUME_ACTIVITY_KIND,
  type UsageResumePayload,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
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
  USAGE_RESUME_STARTUP_GRACE_MS,
  UsageResume,
  layer,
} from "./UsageResume.ts";

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
    const continues = yield* Queue.unbounded<{ threadId: string; messageId: string }>();
    const awake = yield* Ref.make<ReadonlyArray<boolean>>([]);
    const windows = yield* Ref.make<ReadonlyArray<Window>>([]);
    const publish = (event: unknown) => PubSub.publish(events, event as OrchestrationEvent);

    const shell = {
      id: THREAD,
      archivedAt: null,
      modelSelection: { instanceId: "claudeAgent", model: "sonnet" },
      session: { status: "error", providerInstanceId: "claudeAgent", lastError: LIMIT_TEXT },
    } as unknown as OrchestrationThreadShell;

    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 1,
            projects: [],
            threads: [shell],
            updatedAt: "2026-01-01T00:00:00.000Z",
          }),
      }),
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          command.type === "thread.activity.append" &&
          command.activity.kind === USAGE_RESUME_ACTIVITY_KIND
            ? Ref.update(activities, (all) => [
                ...all,
                command.activity.payload as UsageResumePayload,
              ]).pipe(Effect.as({ sequence: 1 }))
            : Effect.succeed({ sequence: 1 }),
        subscribeDomainEvents: PubSub.subscribe(events).pipe(
          Effect.map((subscription) => Stream.fromSubscription(subscription)),
        ),
      }),
      Layer.mock(ProviderRegistry)({
        getProviders: Ref.get(windows).pipe(
          Effect.map(
            (all) => [{ instanceId: "claudeAgent", usageLimits: { windows: all } }] as never,
          ),
        ),
      }),
      Layer.mock(AgentMessaging)({
        continueAfterLimit: (threadId, messageId) =>
          Queue.offer(continues, { threadId, messageId }).pipe(Effect.as(true)),
      }),
      ServerSettingsService.layerTest(settings),
      DesktopTelemetryReceiver.layerTest({
        setKeepAwake: (enabled) => Ref.update(awake, (all) => [...all, enabled]),
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
      continues,
      states,
      activities,
      awake: Ref.get(awake),
      /** The thread's turn ends with an error, or a limit error if none is given. */
      fail: (lastError = LIMIT_TEXT) =>
        publish({
          type: "thread.session-set",
          payload: { threadId: THREAD, session: { status: "error", lastError } },
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
            yield* settle;

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
          yield* harness.fail("429 too many requests");
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
          yield* harness.fail("429 too many requests");
          yield* settle;
          assert.isTrue(yield* resume.resumeNow(THREAD));
          const started = yield* Queue.take(harness.continues);
          assert.equal(started.threadId, THREAD);
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
});
