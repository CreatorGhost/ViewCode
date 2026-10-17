import type { DesktopTailscalePhoneAccess as PhoneAccess } from "@t3tools/contracts";
import { HostProcessEnvironment, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { isCommandAvailable } from "@t3tools/shared/shell";
import { findTailscaleExecutable, readTailscaleStatus } from "@t3tools/tailscale";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

/**
 * ViewCode: Tailscale as a Connect phone option.
 *
 * Detection is a filesystem search for the CLI and nothing else. It never
 * spawns a process, so a computer without Tailscale sees no side effect. When
 * the CLI is found and Tailscale is signed in, launch turns Tailscale Serve on
 * unless the user turned that off; phones still have to pair.
 */

const { logInfo, logWarning } = makeComponentLogger("desktop-tailscale-phone");

/** Whether launch should turn Tailscale Serve on by itself. */
export function shouldAutoEnableTailscaleServe(input: {
  readonly settings: Pick<
    DesktopAppSettings.DesktopSettings,
    "tailscaleServeEnabled" | "tailscaleAutoServe"
  >;
  readonly installed: boolean;
}): boolean {
  return (
    input.installed && input.settings.tailscaleAutoServe && !input.settings.tailscaleServeEnabled
  );
}

/**
 * Looks for the `tailscale` CLI on PATH, then at its fixed install paths (the
 * Mac app, Homebrew, Program Files, distro and snap locations). Only checks
 * files; spawns nothing.
 */
export const detectTailscaleInstalled = Effect.fnUntraced(function* (env?: NodeJS.ProcessEnv) {
  const searchEnv = env ?? (yield* HostProcessEnvironment);
  const found = yield* findTailscaleExecutable({
    platform: yield* HostProcessPlatform,
    env: searchEnv,
    isAvailable: (command) => isCommandAvailable(command, { env: searchEnv }),
  });
  return found !== null;
});

export class DesktopTailscalePhoneAccess extends Context.Service<
  DesktopTailscalePhoneAccess,
  {
    /** Runs once, before the backend's exposure is resolved. */
    readonly applyAtStartup: Effect.Effect<void>;
    readonly get: Effect.Effect<PhoneAccess>;
    readonly setAutomatic: (automatic: boolean) => Effect.Effect<PhoneAccess>;
  }
>()("@t3tools/desktop/backend/DesktopTailscalePhoneAccess") {}

export const make = Effect.gen(function* () {
  const settings = yield* DesktopAppSettings.DesktopAppSettings;
  const serverExposure = yield* DesktopServerExposure.DesktopServerExposure;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const detect = detectTailscaleInstalled().pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );
  // Serve needs the tailnet's HTTPS name, which a signed-out Tailscale lacks.
  const signedIn = readTailscaleStatus.pipe(
    Effect.map((status) => status.magicDnsName !== null),
    Effect.orElseSucceed(() => false),
    Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner),
  );

  const snapshot = Effect.gen(function* () {
    const current = yield* settings.get;
    return {
      installed: yield* detect,
      automatic: current.tailscaleAutoServe,
    } satisfies PhoneAccess;
  });

  const applyAtStartup = Effect.gen(function* () {
    const current = yield* settings.get;
    // Cheapest first: the settings, then a file lookup, then one `tailscale status`.
    if (!current.tailscaleAutoServe || current.tailscaleServeEnabled) return;
    if (!shouldAutoEnableTailscaleServe({ settings: current, installed: yield* detect })) return;
    if (!(yield* signedIn)) return;
    // The backend has not started yet, so the new setting simply applies to it.
    yield* serverExposure.setTailscaleServeEnabled({ enabled: true, automatic: true }).pipe(
      Effect.tap(() => logInfo("turned on Tailscale Serve at launch")),
      Effect.catch((error) =>
        logWarning("could not turn on Tailscale Serve at launch", { message: error.message }),
      ),
    );
  }).pipe(Effect.withSpan("desktop.tailscalePhoneAccess.applyAtStartup"));

  const setAutomatic = Effect.fn("desktop.tailscalePhoneAccess.setAutomatic")(function* (
    automatic: boolean,
  ) {
    const current = yield* settings.get;
    yield* serverExposure
      .setTailscaleServeEnabled({ enabled: current.tailscaleServeEnabled, automatic })
      .pipe(
        Effect.catch((error) =>
          logWarning("could not save the Tailscale launch setting", { message: error.message }),
        ),
      );
    return yield* snapshot;
  });

  return DesktopTailscalePhoneAccess.of({ applyAtStartup, get: snapshot, setAutomatic });
});

export const layer = Layer.effect(DesktopTailscalePhoneAccess, make);
