import type { DesktopTailscalePhoneAccess as PhoneAccess } from "@t3tools/contracts";
import { isCommandAvailable } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as DesktopServerExposure from "./DesktopServerExposure.ts";

/**
 * ViewCode: Tailscale as a Connect phone option.
 *
 * Detection is a filesystem search for the CLI and nothing else. It never
 * spawns a process, so a computer without Tailscale sees no side effect and a
 * managed laptop whose security software kills tailscaled is left alone until
 * the user turns Tailscale on. The optional launch-time setting is off by
 * default for the same reason.
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
    input.installed &&
    input.settings.tailscaleAutoServe === true &&
    !input.settings.tailscaleServeEnabled
  );
}

/** Looks for the `tailscale` CLI on PATH. Only checks files; spawns nothing. */
export const detectTailscaleInstalled = (env?: NodeJS.ProcessEnv) =>
  isCommandAvailable("tailscale", env === undefined ? {} : { env });

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
  const detect = detectTailscaleInstalled().pipe(
    Effect.provideService(FileSystem.FileSystem, fileSystem),
    Effect.provideService(Path.Path, path),
  );

  const snapshot = Effect.gen(function* () {
    const current = yield* settings.get;
    return {
      installed: yield* detect,
      automatic: current.tailscaleAutoServe === true,
    } satisfies PhoneAccess;
  });

  const applyAtStartup = Effect.gen(function* () {
    const current = yield* settings.get;
    // The setting is checked first so the default (off) does not even search PATH.
    if (current.tailscaleAutoServe !== true || current.tailscaleServeEnabled) return;
    if (!shouldAutoEnableTailscaleServe({ settings: current, installed: yield* detect })) return;
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
