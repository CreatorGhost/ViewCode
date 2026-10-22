import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import { guardProviderInstance } from "./providerLaunchGate.ts";

const makeFixture = (enabled: boolean) => {
  const calls: Array<string> = [];
  const run = (name: string) =>
    Effect.sync(() => {
      calls.push(name);
    });
  const snapshot = { enabled, status: enabled ? "ready" : "disabled" } as ServerProvider;
  const runtime = {
    ensureThread: () => run("ensure"),
    resumeThread: () => run("resume"),
    startTurn: () => run("turn"),
    steerTurn: () => run("steer"),
    respondToRuntimeRequest: () => run("approval"),
    readThreadSnapshot: () => run("read"),
    rollbackThread: () => run("rollback"),
    forkThread: () => run("fork"),
    injectHistory: () => run("history"),
    compactThread: () => run("compact"),
    interruptTurn: () => run("interrupt"),
    stop: run("stop"),
  };
  const original = {
    instanceId: ProviderInstanceId.make("muse"),
    driverKind: ProviderDriverKind.make("muse"),
    enabled,
    snapshot: {
      getSnapshot: Effect.succeed(snapshot),
      refresh: run("probe").pipe(Effect.as(snapshot)),
      streamChanges: Stream.succeed(snapshot),
      resolveMaintenance: () => run("maintenance"),
    },
    snapshotForCwd: () => run("workspace"),
    refreshModels: () => run("models"),
    consumeResetCredit: () => run("credit"),
    orchestrationAdapter: { openSession: () => run("open").pipe(Effect.as(runtime)) },
    textGeneration: {
      generateCommitMessage: () => run("commit"),
      generatePrContent: () => run("pr"),
      generateBranchName: () => run("branch"),
      generateThreadTitle: () => run("title"),
      generateReviewGuide: () => run("review"),
    },
    auth: {
      start: () => run("auth"),
      complete: () => run("complete"),
      logout: () => run("logout"),
      refreshMethods: run("refresh-auth"),
    },
    acpSessionManagement: {
      listSessions: () => run("sessions"),
      logout: () => run("acp-logout"),
      deleteSession: () => run("delete"),
      listProviders: () => run("providers"),
      setProvider: () => run("set"),
      disableProvider: () => run("disable"),
    },
  } as unknown as ProviderInstance;
  return { calls, original };
};

describe("ViewCode provider launch gate", () => {
  it.effect("a disabled provider stays unprobed but permits explicit sign-in setup", () =>
    Effect.gen(function* () {
      const { calls, original } = makeFixture(false);
      const instance = guardProviderInstance(original, false);
      yield* instance.snapshot.refresh;
      yield* instance.auth!.refreshMethods!;
      assert.deepEqual(calls, []);
      const blocked = yield* instance.orchestrationAdapter
        .openSession({} as never)
        .pipe(Effect.result);
      assert.equal(blocked._tag, "Failure");
      yield* instance.textGeneration.generateThreadTitle({} as never).pipe(Effect.result);
      yield* instance.refreshModels!().pipe(Effect.result);
      yield* instance.acpSessionManagement!.listSessions({ cwd: "/work" }).pipe(Effect.result);
      assert.deepEqual(calls, []);
      yield* instance.auth!.start({} as never);
      assert.deepEqual(calls, ["auth"]);
    }).pipe(
      Effect.provideService(AdminPolicyRef, {
        blockedDrivers: [],
        tailscaleBlocked: false,
        problem: null,
      }),
    ),
  );

  it.effect(
    "admin policy overrides enablement, model refresh, authentication and maintenance",
    () =>
      Effect.gen(function* () {
        const { calls, original } = makeFixture(true);
        const instance = guardProviderInstance(original, true);
        const snapshot = yield* instance.snapshot.refresh;
        assert.isTrue(snapshot.disabledByAdmin);
        assert.isFalse(snapshot.enabled);
        assert.equal(snapshot.status, "disabled");
        yield* instance.orchestrationAdapter.openSession({} as never).pipe(Effect.result);
        yield* instance.auth!.start({} as never).pipe(Effect.result);
        yield* instance.auth!.complete({} as never, {} as never).pipe(Effect.result);
        yield* instance.consumeResetCredit!().pipe(Effect.result);
        yield* instance.snapshot.resolveMaintenance({ fresh: true });
        assert.deepEqual(calls, []);
      }).pipe(
        Effect.provideService(AdminPolicyRef, {
          blockedDrivers: ["muse"],
          tailscaleBlocked: false,
          problem: null,
        }),
      ),
  );

  it.effect("rechecks policy for an already opened runtime while leaving cleanup available", () =>
    Effect.gen(function* () {
      const { calls, original } = makeFixture(true);
      const instance = guardProviderInstance(original, false);
      const runtime = yield* instance.orchestrationAdapter.openSession({} as never);
      yield* runtime.startTurn({} as never);
      const blocked = { blockedDrivers: ["muse"], tailscaleBlocked: false, problem: null };
      yield* Effect.all([
        runtime.startTurn({} as never).pipe(Effect.result),
        runtime.resumeThread({} as never).pipe(Effect.result),
        runtime.injectHistory!({} as never).pipe(Effect.result),
      ]).pipe(Effect.provideService(AdminPolicyRef, blocked));
      yield* runtime.interruptTurn({} as never);
      assert.deepEqual(calls, ["open", "turn", "interrupt"]);
    }).pipe(
      Effect.provideService(AdminPolicyRef, {
        blockedDrivers: [],
        tailscaleBlocked: false,
        problem: null,
      }),
    ),
  );

  it.effect("refuses to launch a provider whose executable is missing, with a clear reason", () =>
    Effect.gen(function* () {
      const { calls, original } = makeFixture(true);
      let missing = false;
      const instance = guardProviderInstance(
        original,
        false,
        Effect.sync(() => missing),
      );
      const runtime = yield* instance.orchestrationAdapter.openSession({} as never);
      missing = true;
      const refused = yield* Effect.all([
        instance.orchestrationAdapter.openSession({} as never).pipe(Effect.flip),
        runtime.startTurn({} as never).pipe(Effect.flip),
        runtime.compactThread!({} as never).pipe(Effect.flip),
        instance.textGeneration.generateThreadTitle({} as never).pipe(Effect.flip),
      ]);
      for (const error of refused) {
        assert.include(
          "detail" in error ? error.detail : "",
          "The executable for provider instance 'muse' was not found, so it was not launched.",
        );
      }
      // The session already running stays reachable; probes keep reporting install state.
      yield* runtime.respondToRuntimeRequest({} as never);
      yield* runtime.interruptTurn({} as never);
      yield* instance.snapshot.refresh;
      assert.deepEqual(calls, ["open", "approval", "interrupt", "probe"]);
    }).pipe(
      Effect.provideService(AdminPolicyRef, {
        blockedDrivers: [],
        tailscaleBlocked: false,
        problem: null,
      }),
    ),
  );
});
