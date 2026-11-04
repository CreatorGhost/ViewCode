import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderHost from "./ProviderHost.ts";
import { makeManagedServerProvider } from "./managedProvider.ts";

const initialSnapshot: ServerProvider = {
  instanceId: ProviderInstanceId.make("codex"),
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "warning",
  auth: { status: "unknown" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  message: "Checking provider availability...",
  models: [],
  slashCommands: [],
  skills: [],
};

const timedOutSnapshot: ServerProvider = {
  ...initialSnapshot,
  status: "error",
  message: "Timed out while checking Codex app-server provider status.",
};

const readySnapshot: ServerProvider = {
  instanceId: initialSnapshot.instanceId,
  driver: initialSnapshot.driver,
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:01.000Z",
  models: [],
  slashCommands: [],
  skills: [],
};

const layerTest = Layer.mergeAll(
  Layer.succeed(
    ProviderHost.ProviderHost,
    ProviderHost.ProviderHost.of({
      paths: {
        cwd: process.cwd(),
        baseDir: "/t3",
        stateDir: "/t3/userdata",
        providerStatusCacheDir: "/t3/caches",
        attachmentsDir: "/t3/userdata/attachments",
      },
      settings: {
        get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
        changes: Stream.empty,
        subscribe: Effect.succeed(Stream.empty),
      },
      shouldRunBackgroundWork: () => Effect.succeed(true),
      resolveAttachmentPath: () => null,
      credentials: () => Effect.die("unused"),
    }),
  ),
  TestClock.layer(),
);

/** A provider whose checks answer in turn from `answers`, the last one repeating. */
const makeProvider = Effect.fn(function* (answers: ReadonlyArray<ServerProvider>) {
  const checkCalls = yield* Ref.make(0);
  const firstCheckDone = yield* Deferred.make<void>();
  const provider = yield* makeManagedServerProvider<{ readonly enabled: boolean }>({
    resolveMaintenance: () => Effect.die("unused"),
    getSettings: Effect.succeed({ enabled: true }),
    streamSettings: Stream.empty,
    haveSettingsChanged: (previous, next) => previous.enabled !== next.enabled,
    initialSnapshot: () => Effect.succeed(initialSnapshot),
    checkProvider: Ref.updateAndGet(checkCalls, (count) => count + 1).pipe(
      Effect.tap(() => Deferred.succeed(firstCheckDone, undefined)),
      Effect.map((count) => answers[Math.min(count, answers.length) - 1]!),
    ),
    refreshInterval: "1 hour",
  });
  yield* Deferred.await(firstCheckDone);
  return { provider, checkCalls };
});

const advance = Effect.fn(function* (step: "15 seconds" | "60 seconds" | "10 minutes") {
  yield* TestClock.adjust(step);
  yield* Effect.yieldNow;
});

// ViewCode: a provider whose startup check timed out is checked again within a minute,
// instead of showing no status until the next health interval.
describe("makeManagedServerProvider startup retry", () => {
  it.effect("retries an inconclusive startup probe soon instead of waiting for the interval", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { provider, checkCalls } = yield* makeProvider([timedOutSnapshot, readySnapshot]);

        yield* advance("15 seconds");
        assert.deepStrictEqual(yield* provider.getSnapshot, readySnapshot);

        // A conclusive answer ends the retries.
        yield* advance("10 minutes");
        assert.strictEqual(yield* Ref.get(checkCalls), 2);
      }),
    ).pipe(Effect.provide(layerTest)),
  );

  it.effect("stops retrying a startup probe that stays inconclusive", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { checkCalls } = yield* makeProvider([timedOutSnapshot]);

        yield* advance("15 seconds");
        yield* advance("60 seconds");
        yield* advance("10 minutes");
        assert.strictEqual(yield* Ref.get(checkCalls), 3);
      }),
    ).pipe(Effect.provide(layerTest)),
  );
});
