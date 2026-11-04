import * as HostProcess from "@t3tools/shared/HostProcess";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import {
  disableTailscaleServe,
  ensureTailscaleServe,
  readTailscaleSshEnabled,
  readTailscaleStatus,
  resolveTailscaleBlock,
  TailscaleDisabledError,
} from "./tailscale.ts";

// ViewCode guards (69a4b5d3a, 5c46a5e39): with Tailscale switched off by the environment or
// blocked by IT policy, no tailscale command runs at all. Any spawn here is a defect.
const noSpawns = Layer.merge(
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make(() => Effect.die(new Error("tailscale ran"))),
  ),
  Layer.succeed(HostProcess.Platform, "linux"),
);
const unblocked = { blockedDrivers: [], tailscaleBlocked: false, problem: null };

const everyCommand = Effect.all([
  readTailscaleStatus.pipe(Effect.flip),
  readTailscaleSshEnabled.pipe(Effect.flip),
  ensureTailscaleServe({ localPort: 3773 }).pipe(Effect.flip),
  disableTailscaleServe({ servePort: 443 }).pipe(Effect.flip),
]);

describe("tailscale switched off (ViewCode)", () => {
  it.effect("runs no command at all while VIEWCODE_DISABLE_TAILSCALE is set", () =>
    Effect.gen(function* () {
      for (const error of yield* everyCommand) {
        assert.instanceOf(error, TailscaleDisabledError);
      }
    }).pipe(
      Effect.provide(noSpawns),
      Effect.provideService(HostProcess.Environment, { VIEWCODE_DISABLE_TAILSCALE: "1" }),
      Effect.provideService(AdminPolicyRef, unblocked),
    ),
  );

  it.effect("runs no command at all while the admin policy blocks Tailscale", () =>
    Effect.gen(function* () {
      for (const error of yield* everyCommand) {
        assert.instanceOf(error, TailscaleDisabledError);
        assert.equal((error as TailscaleDisabledError).reason, "policy");
      }
    }).pipe(
      Effect.provide(noSpawns),
      Effect.provideService(HostProcess.Environment, {}),
      Effect.provideService(AdminPolicyRef, { ...unblocked, tailscaleBlocked: true }),
    ),
  );

  it("lets the admin policy outrank the environment switch, and both the setting", () => {
    const off = { VIEWCODE_DISABLE_TAILSCALE: "true" };
    const block = (policyBlocked: boolean, env: NodeJS.ProcessEnv, settingEnabled: boolean) =>
      resolveTailscaleBlock({ policyBlocked, env, settingEnabled });
    assert.equal(block(false, {}, true), null);
    assert.equal(block(false, {}, false), "setting");
    assert.equal(block(false, off, true), "environment");
    assert.equal(block(false, { VIEWCODE_DISABLE_TAILSCALE: "0" }, true), null);
    assert.equal(block(true, {}, true), "policy");
    assert.equal(block(true, off, false), "policy");
  });
});
