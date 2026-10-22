import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { AnyProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeProviderInstanceRegistry } from "./ProviderInstanceRegistry.ts";

// ViewCode guard (ac4569d58, 9c96e92fd): every instance upstream's registry builds is wrapped
// in ViewCode's launch gate, so a disabled, admin-blocked or missing provider is refused
// before it runs. The gate has its own tests; this one fails when the registry stops
// applying it, which a merge can do without a conflict or a type error.

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const INSTALLED = "/opt/claude/bin/claude";

const snapshot = { enabled: true, status: "ready" } as ServerProvider;

const makeDriver = (opened: Array<string>): AnyProviderDriver<never> =>
  ({
    driverKind: CLAUDE,
    metadata: { displayName: "Claude" },
    configSchema: Schema.Struct({ binaryPath: Schema.optional(Schema.String) }),
    defaultConfig: () => ({}),
    create: (input: { instanceId: ProviderInstanceId; enabled: boolean }) =>
      Effect.succeed({
        instanceId: input.instanceId,
        driverKind: CLAUDE,
        enabled: input.enabled,
        snapshot: {
          getSnapshot: Effect.succeed(snapshot),
          refresh: Effect.succeed(snapshot),
          streamChanges: Stream.empty,
          resolveMaintenance: () => Effect.void,
        },
        textGeneration: {},
        orchestrationAdapter: {
          openSession: () =>
            Effect.sync(() => {
              opened.push(input.instanceId);
              return {};
            }),
        },
      } as unknown as ProviderInstance),
  }) as unknown as AnyProviderDriver<never>;

const openSessionOf = (input: { readonly enabled: boolean; readonly binaryPath: string }) =>
  Effect.gen(function* () {
    const opened: Array<string> = [];
    const instanceId = ProviderInstanceId.make("claude_guard");
    const { registry } = yield* makeProviderInstanceRegistry({
      drivers: [makeDriver(opened)],
      configMap: {
        [instanceId]: {
          driver: CLAUDE,
          enabled: input.enabled,
          config: { binaryPath: input.binaryPath },
        },
      },
    });
    const instance = yield* registry.getInstance(instanceId);
    const result = yield* instance!.orchestrationAdapter
      .openSession({} as never)
      .pipe(Effect.result);
    return { opened, result };
  }).pipe(
    Effect.scoped,
    Effect.provideService(AdminPolicyRef, {
      blockedDrivers: [],
      tailscaleBlocked: false,
      problem: null,
    }),
    Effect.provideService(HostProcess.Platform, "linux"),
    Effect.provideService(HostProcess.HomeDirectory, "/home/guard"),
    Effect.provideService(HostProcess.Environment, {}),
    Effect.provideService(SpawnExecutableResolution, (command) =>
      command === INSTALLED ? INSTALLED : undefined,
    ),
  );

const failureMessage = (result: { readonly _tag: string; readonly failure?: unknown }) =>
  result._tag === "Failure" ? String(Reflect.get(Object(result.failure), "detail") ?? "") : "";

describe("ProviderInstanceRegistry launch gate (ViewCode)", () => {
  it.effect("refuses to launch a provider whose executable is missing", () =>
    Effect.gen(function* () {
      const { opened, result } = yield* openSessionOf({
        enabled: true,
        binaryPath: "/opt/missing/claude",
      });
      assert.equal(result._tag, "Failure");
      assert.include(failureMessage(result), "was not found, so it was not launched");
      assert.deepEqual(opened, []);
    }),
  );

  it.effect("refuses to launch a provider the user has not turned on", () =>
    Effect.gen(function* () {
      const { opened, result } = yield* openSessionOf({ enabled: false, binaryPath: INSTALLED });
      assert.equal(result._tag, "Failure");
      assert.deepEqual(opened, []);
    }),
  );

  it.effect("launches an enabled provider whose executable is found", () =>
    Effect.gen(function* () {
      const { opened, result } = yield* openSessionOf({ enabled: true, binaryPath: INSTALLED });
      assert.equal(result._tag, "Success");
      assert.deepEqual(opened, ["claude_guard"]);
    }),
  );
});
