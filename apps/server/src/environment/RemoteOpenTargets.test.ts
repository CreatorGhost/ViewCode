import { it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ensureTailscaleServe } from "@t3tools/tailscale";
import * as NetService from "@t3tools/shared/Net";
import { AdminPolicyRef } from "@t3tools/shared/viewcodeAdminPolicy";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { describe, expect } from "vite-plus/test";

import * as ServerSettings from "../serverSettings.ts";
import * as RemoteOpenTargets from "./RemoteOpenTargets.ts";
import * as TailscaleAccess from "./TailscaleAccess.ts";

const encoder = new TextEncoder();

const TAILSCALE_STATUS_JSON = JSON.stringify({
  Self: { DNSName: "bb-1.tail1234.ts.net.", TailscaleIPs: ["100.64.1.2"] },
});

interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
}

/** Records each `tailscale` subcommand it is asked to run. */
const layerSpawner = (
  input: { readonly status: CommandResult; readonly prefs: CommandResult },
  spawned: Array<string> = [],
) =>
  Layer.succeed(
    ChildProcessSpawner.ChildProcessSpawner,
    ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args : [];
      spawned.push(args[0] ?? "");
      const result = args[0] === "debug" ? input.prefs : input.status;
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(1),
          exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(result.exitCode)),
          isRunning: Effect.succeed(false),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.make(encoder.encode(result.stdout)),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    }),
  );

const layerNet = (input: { readonly ipv4: boolean; readonly ipv6: boolean }) =>
  Layer.succeed(NetService.NetService, {
    canListenOnHost: () => Effect.succeed(true),
    isPortAvailableOnLoopback: () => Effect.succeed(true),
    hasListenerOnHost: (_port, host) => Effect.succeed(host === "::1" ? input.ipv6 : input.ipv4),
    reserveLoopbackPort: () => Effect.succeed(40_000),
    findAvailablePort: (preferred) => Effect.succeed(preferred),
  });

const layerRemoteOpenTargets = (input: {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean };
  readonly tailscale: { readonly status: CommandResult; readonly prefs: CommandResult };
  readonly spawned?: Array<string>;
  readonly tailscaleEnabled?: boolean;
  readonly env?: NodeJS.ProcessEnv;
  readonly policyBlocksTailscale?: boolean;
}) =>
  RemoteOpenTargets.layer.pipe(
    Layer.provideMerge(TailscaleAccess.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        layerNet(input.sshd),
        layerSpawner(input.tailscale, input.spawned),
        ServerSettings.ServerSettingsService.layerTest({
          tailscaleEnabled: input.tailscaleEnabled ?? true,
        }),
        Layer.succeed(HostProcess.Environment, input.env ?? {}),
        Layer.succeed(AdminPolicyRef, {
          blockedDrivers: [],
          tailscaleBlocked: input.policyBlocksTailscale ?? false,
          problem: null,
        }),
      ),
    ),
  );

const resolveTargets = (input: {
  readonly sshd: { readonly ipv4: boolean; readonly ipv6: boolean };
  readonly tailscale: { readonly status: CommandResult; readonly prefs: CommandResult };
  readonly hostname: string;
}) =>
  Effect.flatMap(RemoteOpenTargets.RemoteOpenTargets, (service) => service.resolveTargets()).pipe(
    Effect.provideService(HostProcess.Hostname, input.hostname),
    Effect.provide(layerRemoteOpenTargets(input)),
  );

const prefsJson = (prefs: { readonly RunSSH: boolean; readonly WantRunning: boolean }) => ({
  exitCode: 0,
  stdout: JSON.stringify(
    { ControlURL: "https://controlplane.tailscale.com", ...prefs },
    null,
    "\t",
  ),
});

const STATUS_UP = { exitCode: 0, stdout: TAILSCALE_STATUS_JSON };
const TAILSCALE_UP = { status: STATUS_UP, prefs: prefsJson({ RunSSH: false, WantRunning: true }) };
const TAILSCALE_SSH = { status: STATUS_UP, prefs: prefsJson({ RunSSH: true, WantRunning: true }) };
const SSHD_UP = { ipv4: true, ipv6: true };
const TAILSCALE_DOWN = { status: { exitCode: 1, stdout: "" }, prefs: { exitCode: 1, stdout: "" } };

describe("RemoteOpenTargets", () => {
  it.effect("advertises nothing when no sshd accepts and Tailscale SSH is off", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("advertises only the tailnet name when Tailscale SSH serves without sshd", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: TAILSCALE_SSH,
        hostname: "bb-1",
      });
      expect(targets).toEqual([{ kind: "tailscale", host: "bb-1.tail1234.ts.net" }]);
    }),
  );

  it.effect("ignores a stored RunSSH after `tailscale down`", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: false },
        tailscale: { status: STATUS_UP, prefs: prefsJson({ RunSSH: true, WantRunning: false }) },
        hostname: "bb-1",
      });
      expect(targets).toEqual([]);
    }),
  );

  it.effect("orders the tailnet name before the mDNS name", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_UP,
        hostname: "bb-1",
      });
      expect(targets).toEqual([
        { kind: "tailscale", host: "bb-1.tail1234.ts.net" },
        { kind: "mdns", host: "bb-1.local" },
      ]);
    }),
  );

  it.effect("accepts an sshd bound to IPv6 loopback only", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: false, ipv6: true },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );

  it.effect("falls back to mDNS alone when tailscale is unavailable", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: false },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );

  it.effect("shortens an FQDN hostname to its first label for mDNS", () =>
    Effect.gen(function* () {
      const targets = yield* resolveTargets({
        sshd: { ipv4: true, ipv6: true },
        tailscale: TAILSCALE_DOWN,
        hostname: "bb-1.example.com",
      });
      expect(targets).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
    }),
  );

  describe("on a managed Mac", () => {
    it.effect("starts and builds the config's targets without running tailscale", () => {
      const spawned: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* RemoteOpenTargets.RemoteOpenTargets;
        const access = yield* TailscaleAccess.TailscaleAccess;
        // Everything the server config read touches.
        expect(yield* service.cachedTargets).toEqual(Option.none());
        expect(yield* service.cachedTargets).toEqual(Option.none());
        expect(yield* access.blockReason).toBeNull();
        expect(yield* access.cachedStatus).toEqual(Option.none());
        expect(spawned).toEqual([]);
      }).pipe(
        Effect.provide(
          layerRemoteOpenTargets({ sshd: SSHD_UP, tailscale: TAILSCALE_SSH, spawned }),
        ),
      );
    });

    it.effect("runs tailscale once when open in editor asks, then serves the cache", () => {
      const spawned: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* RemoteOpenTargets.RemoteOpenTargets;
        const expected = [
          { kind: "tailscale", host: "bb-1.tail1234.ts.net" },
          { kind: "mdns", host: "bb-1.local" },
        ];
        expect(yield* service.resolveTargets()).toEqual(expected);
        expect(spawned).toEqual(["status"]);
        expect(yield* service.resolveTargets()).toEqual(expected);
        expect(yield* service.cachedTargets).toEqual(Option.some(expected));
        expect(spawned).toEqual(["status"]);
      }).pipe(
        Effect.provideService(HostProcess.Hostname, "bb-1"),
        Effect.provide(
          layerRemoteOpenTargets({ sshd: SSHD_UP, tailscale: TAILSCALE_SSH, spawned }),
        ),
      );
    });

    it.effect("runs nothing with the Tailscale setting off", () => {
      const spawned: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* RemoteOpenTargets.RemoteOpenTargets;
        const access = yield* TailscaleAccess.TailscaleAccess;
        expect(yield* service.resolveTargets()).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
        expect(yield* access.blockReason).toBe("setting");
        const error = yield* access
          .run(ensureTailscaleServe({ localPort: 3773 }))
          .pipe(Effect.flip);
        expect(error.message).toBe("Tailscale is turned off in ViewCode settings.");
        expect(spawned).toEqual([]);
      }).pipe(
        Effect.provideService(HostProcess.Hostname, "bb-1"),
        Effect.provide(
          layerRemoteOpenTargets({
            sshd: SSHD_UP,
            tailscale: TAILSCALE_SSH,
            spawned,
            tailscaleEnabled: false,
          }),
        ),
      );
    });

    it.effect("runs nothing with VIEWCODE_DISABLE_TAILSCALE set", () => {
      const spawned: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* RemoteOpenTargets.RemoteOpenTargets;
        const access = yield* TailscaleAccess.TailscaleAccess;
        expect(yield* service.resolveTargets()).toEqual([]);
        expect(yield* access.blockReason).toBe("environment");
        expect(spawned).toEqual([]);
      }).pipe(
        Effect.provideService(HostProcess.Hostname, "bb-1"),
        Effect.provide(
          layerRemoteOpenTargets({
            sshd: { ipv4: false, ipv6: false },
            tailscale: TAILSCALE_SSH,
            spawned,
            env: { VIEWCODE_DISABLE_TAILSCALE: "1" },
          }),
        ),
      );
    });

    it.effect("runs nothing when the admin policy blocks Tailscale, whatever the setting", () => {
      const spawned: Array<string> = [];
      return Effect.gen(function* () {
        const service = yield* RemoteOpenTargets.RemoteOpenTargets;
        const access = yield* TailscaleAccess.TailscaleAccess;
        expect(yield* service.resolveTargets()).toEqual([{ kind: "mdns", host: "bb-1.local" }]);
        expect(yield* access.blockReason).toBe("policy");
        const error = yield* access
          .run(ensureTailscaleServe({ localPort: 3773 }))
          .pipe(Effect.flip);
        expect(error.message).toBe("Tailscale is blocked by your organization.");
        // Even a caller that skips TailscaleAccess cannot run the CLI.
        yield* ensureTailscaleServe({ localPort: 3773 }).pipe(Effect.flip);
        expect(spawned).toEqual([]);
      }).pipe(
        Effect.provideService(HostProcess.Hostname, "bb-1"),
        Effect.provide(
          layerRemoteOpenTargets({
            sshd: SSHD_UP,
            tailscale: TAILSCALE_SSH,
            spawned,
            tailscaleEnabled: true,
            policyBlocksTailscale: true,
          }),
        ),
      );
    });

    it.effect("drops a cached tailnet name once Tailscale is turned off", () =>
      Effect.gen(function* () {
        const service = yield* RemoteOpenTargets.RemoteOpenTargets;
        const settings = yield* ServerSettings.ServerSettingsService;
        yield* service.resolveTargets();
        yield* settings.updateSettings({ tailscaleEnabled: false });
        expect(yield* service.cachedTargets).toEqual(
          Option.some([{ kind: "mdns", host: "bb-1.local" }]),
        );
      }).pipe(
        Effect.provideService(HostProcess.Hostname, "bb-1"),
        Effect.provide(layerRemoteOpenTargets({ sshd: SSHD_UP, tailscale: TAILSCALE_UP })),
      ),
    );
  });
});
