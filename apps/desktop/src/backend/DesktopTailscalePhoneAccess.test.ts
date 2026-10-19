import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";
import * as DesktopTailscaleGate from "./DesktopTailscaleGate.ts";
import {
  DesktopTailscalePhoneAccess,
  detectTailscaleInstalled,
  layer as tailscalePhoneAccessLayer,
  shouldAutoEnableTailscaleServe,
} from "./DesktopTailscalePhoneAccess.ts";

const { DEFAULT_DESKTOP_SETTINGS } = DesktopAppSettings;

describe("shouldAutoEnableTailscaleServe", () => {
  const defaults = {
    tailscaleServeEnabled: DEFAULT_DESKTOP_SETTINGS.tailscaleServeEnabled,
    tailscaleAutoServe: DEFAULT_DESKTOP_SETTINGS.tailscaleAutoServe,
  };

  it("stays off until the user opts in", () => {
    assert.isFalse(shouldAutoEnableTailscaleServe({ settings: defaults, installed: true }));
    const optedIn = { ...defaults, tailscaleAutoServe: true };
    assert.isTrue(shouldAutoEnableTailscaleServe({ settings: optedIn, installed: true }));
    assert.isFalse(shouldAutoEnableTailscaleServe({ settings: optedIn, installed: false }));
  });

  it("stays off once the user turned it off", () => {
    assert.isFalse(
      shouldAutoEnableTailscaleServe({
        settings: { ...defaults, tailscaleAutoServe: false },
        installed: true,
      }),
    );
  });

  it("leaves a Serve that is already on alone", () => {
    assert.isFalse(
      shouldAutoEnableTailscaleServe({
        settings: { tailscaleServeEnabled: true, tailscaleAutoServe: true },
        installed: true,
      }),
    );
  });
});

describe("detectTailscaleInstalled", () => {
  // A platform with no known install paths, so the result depends on PATH alone
  // and not on whether this machine has Tailscale.
  const onlyPathCounts = Effect.provideService(HostProcessPlatform, "freebsd");

  it.effect("finds the CLI on PATH by looking at files only", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const empty = yield* fileSystem.makeTempDirectoryScoped();
      const installed = yield* fileSystem.makeTempDirectoryScoped();
      const cli = path.join(installed, "tailscale");
      yield* fileSystem.writeFileString(cli, "#!/bin/sh\n");
      yield* fileSystem.chmod(cli, 0o755);
      assert.isFalse(yield* detectTailscaleInstalled({ PATH: empty }));
      assert.isTrue(yield* detectTailscaleInstalled({ PATH: installed }));
    }).pipe(Effect.scoped, onlyPathCounts, Effect.provide(NodeServices.layer)),
  );

  it.effect("reports an empty PATH as not installed", () =>
    detectTailscaleInstalled({ PATH: "" }).pipe(
      Effect.map((installed) => assert.isFalse(installed)),
      onlyPathCounts,
      Effect.provide(NodeServices.layer),
    ),
  );
});

describe("applyAtStartup", () => {
  /** A fake `tailscale status --json` that prints `statusJson`; nothing is executed. */
  const statusSpawner = (statusJson: string, spawned: { count: number }) =>
    ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        spawned.count++;
      }).pipe(
        Effect.as(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.make(new TextEncoder().encode(statusJson)),
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        ),
      ),
    );

  /**
   * Runs startup with the CLI on PATH and returns the Serve changes it asked
   * for and how many `tailscale` commands it ran.
   */
  const runStartup = (
    statusJson: string,
    options: {
      readonly settings?: DesktopAppSettings.DesktopSettings;
      readonly blockReason?: "environment" | "setting" | null;
    } = {},
  ) =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fileSystem.makeTempDirectoryScoped();
      const cli = path.join(dir, "tailscale");
      yield* fileSystem.writeFileString(cli, "#!/bin/sh\n");
      yield* fileSystem.chmod(cli, 0o755);
      const requests: Array<{ readonly enabled: boolean; readonly automatic?: boolean }> = [];
      const spawned = { count: 0 };
      const access = yield* Layer.build(
        tailscalePhoneAccessLayer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(DesktopAppSettings.DesktopAppSettings)({
                get: Effect.succeed(options.settings ?? DEFAULT_DESKTOP_SETTINGS),
              }),
              Layer.mock(DesktopTailscaleGate.DesktopTailscaleGate)({
                blockReason: Effect.succeed(options.blockReason ?? null),
              }),
              Layer.mock(DesktopServerExposure.DesktopServerExposure)({
                setTailscaleServeEnabled: (input) =>
                  Effect.sync(() => {
                    requests.push(input);
                  }).pipe(Effect.as({} as DesktopServerExposure.DesktopServerExposureChange)),
              }),
              Layer.succeed(
                ChildProcessSpawner.ChildProcessSpawner,
                statusSpawner(statusJson, spawned),
              ),
            ),
          ),
        ),
      );
      yield* DesktopTailscalePhoneAccess.use((service) => service.applyAtStartup).pipe(
        Effect.provide(access),
        Effect.provideService(HostProcessEnvironment, { PATH: dir }),
      );
      return { requests, spawned: spawned.count };
    }).pipe(
      Effect.scoped,
      Effect.provideService(HostProcessPlatform, "freebsd"),
      Effect.provide(NodeServices.layer),
    );

  const SIGNED_IN = '{"Self":{"DNSName":"laptop.tail1234.ts.net.","TailscaleIPs":[]}}';
  const OPTED_IN = { ...DEFAULT_DESKTOP_SETTINGS, tailscaleAutoServe: true };

  it.effect("runs no tailscale on a default launch", () =>
    Effect.gen(function* () {
      const result = yield* runStartup(SIGNED_IN);
      assert.deepStrictEqual(result, { requests: [], spawned: 0 });
    }),
  );

  it.effect("turns Serve on once the user opted in and Tailscale is signed in", () =>
    Effect.gen(function* () {
      const result = yield* runStartup(SIGNED_IN, { settings: OPTED_IN });
      assert.deepStrictEqual(result, {
        requests: [{ enabled: true, automatic: true }],
        spawned: 1,
      });
    }),
  );

  it.effect("leaves Serve off while Tailscale is signed out", () =>
    Effect.gen(function* () {
      const result = yield* runStartup('{"Self":{"TailscaleIPs":[]}}', { settings: OPTED_IN });
      assert.deepStrictEqual(result.requests, []);
    }),
  );

  it.effect("runs no tailscale when Tailscale is turned off, even opted in", () =>
    Effect.gen(function* () {
      for (const blockReason of ["setting", "environment"] as const) {
        const result = yield* runStartup(SIGNED_IN, { settings: OPTED_IN, blockReason });
        assert.deepStrictEqual(result, { requests: [], spawned: 0 });
      }
    }),
  );
});
