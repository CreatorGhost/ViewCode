// @effect-diagnostics nodeBuiltinImport:off - reads ws.ts's own source for a wiring guard.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";
import * as TailscaleAccess from "./TailscaleAccess.ts";

// ViewCode guards (69a4b5d3a): loading the app runs no `tailscale`. The server config reads
// only cached SSH routes, and routes are looked up through the Tailscale switch, so a user
// who turned Tailscale off never has it run. Any spawn here is a defect.

const layer = (input: { readonly tailscaleEnabled: boolean }) =>
  RemoteOpenTargets.layer.pipe(
    Layer.provideMerge(TailscaleAccess.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.succeed(
          ChildProcessSpawner.ChildProcessSpawner,
          ChildProcessSpawner.make(() => Effect.die(new Error("tailscale ran"))),
        ),
        Layer.succeed(NetService.NetService, {
          canListenOnHost: () => Effect.succeed(true),
          isPortAvailableOnLoopback: () => Effect.succeed(true),
          hasListenerOnHost: () => Effect.succeed(true),
          reserveLoopbackPort: () => Effect.succeed(40_000),
          findAvailablePort: (preferred) => Effect.succeed(preferred),
        }),
        ServerSettings.ServerSettingsService.layerTest({
          tailscaleEnabled: input.tailscaleEnabled,
        }),
        Layer.succeed(HostProcess.Environment, {}),
        Layer.succeed(AdminPolicyRef, {
          blockedDrivers: [],
          tailscaleBlocked: false,
          problem: null,
        }),
      ),
    ),
  );

describe("RemoteOpenTargets without running tailscale (ViewCode)", () => {
  it.effect("serves the config's cached routes without probing", () =>
    Effect.gen(function* () {
      const service = yield* RemoteOpenTargets.RemoteOpenTargets;
      expect(yield* service.cachedTargets).toEqual(Option.none());
    }).pipe(Effect.provide(layer({ tailscaleEnabled: true }))),
  );

  it.effect("looks up routes without tailscale when the Tailscale setting is off", () =>
    Effect.gen(function* () {
      const service = yield* RemoteOpenTargets.RemoteOpenTargets;
      expect(yield* service.resolveTargets()).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }).pipe(
      Effect.provideService(HostProcess.Hostname, "bb-1"),
      Effect.provide(layer({ tailscaleEnabled: false })),
    ),
  );

  it("builds the server config from cached routes, never by looking them up", () => {
    const ws = NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", "ws.ts"), "utf8");
    const start = ws.indexOf("const loadServerConfig = ");
    expect(start).toBeGreaterThan(-1);
    const loadServerConfig = ws.slice(start, ws.indexOf("\n      const ", start + 1));
    expect(loadServerConfig).toContain("remoteOpenTargets.cachedTargets");
    expect(loadServerConfig).not.toContain("remoteOpenTargets.resolveTargets");
  });
});
