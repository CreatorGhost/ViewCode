/**
 * ViewCode: one launch check for provider work outside health probes.
 *
 * A provider may be launched only when its instance is enabled in the
 * effective instance map (which is all-off while the first-run selection is
 * pending) and its executable resolves on the filesystem. Health probes get
 * the same rule from `guardMissingProviderBinary`; sessions (new and
 * recovered), text generation and sign-in call `providerLaunchBlockReason`
 * before starting anything.
 *
 * @module provider/providerLaunch
 */
import {
  DEFAULT_SERVER_SETTINGS,
  type DetectedProvider,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";

import { expandHomePath } from "../pathExpansion.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import { resolveCommandCodeBinary } from "./commandCodeCli.ts";
import { resolveProviderBinary } from "./providerBinary.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { BUILT_IN_PROVIDER_DRIVER_KINDS, isProviderSelectionPending } from "./providerSelection.ts";

/** The configured envelope for an instance: explicit entry, else the legacy slot. */
function instanceEntry(
  settings: ServerSettings,
  instanceId: string,
): ProviderInstanceConfig | undefined {
  const explicit = settings.providerInstances[instanceId as ProviderInstanceId];
  if (explicit) return explicit;
  const legacy = settings.providers[instanceId as keyof ServerSettings["providers"]];
  return legacy ? { driver: instanceId as ProviderDriverKind, config: legacy } : undefined;
}

function configuredBinaryPath(entry: ProviderInstanceConfig): string {
  const config = entry.config;
  if (Predicate.isObject(config) && typeof config["binaryPath"] === "string") {
    return config["binaryPath"];
  }
  const defaults = DEFAULT_SERVER_SETTINGS.providers[
    entry.driver as keyof ServerSettings["providers"]
  ] as { readonly binaryPath?: string } | undefined;
  return defaults?.binaryPath ?? "";
}

/**
 * Where an instance's executable is, by filesystem lookup only (configured
 * path, else PATH with the instance's environment). `undefined` when the
 * instance needs no local executable or its driver has no known lookup.
 */
const resolveInstanceExecutable = Effect.fn("resolveInstanceExecutable")(function* (
  entry: ProviderInstanceConfig,
): Effect.fn.Return<string | null | undefined, never, FileSystem.FileSystem | Path.Path> {
  const config = entry.config;
  // OpenCode pointed at an external server runs no local binary.
  if (
    entry.driver === "opencode" &&
    Predicate.isObject(config) &&
    typeof config["serverUrl"] === "string" &&
    config["serverUrl"].trim().length > 0
  ) {
    return undefined;
  }
  const env = mergeProviderInstanceEnvironment(entry.environment);
  const binaryPath = expandHomePath(configuredBinaryPath(entry).trim());
  if (entry.driver === "antigravity") {
    const installation = yield* Effect.serviceOption(AntigravityInstallation);
    if (Option.isNone(installation)) return undefined;
    return yield* installation.value.resolve(binaryPath, env).pipe(
      Effect.map((executable) => executable.executablePath),
      Effect.orElseSucceed(() => null),
    );
  }
  if (entry.driver === "commandCode") {
    const platform = yield* HostProcessPlatform;
    return yield* resolveProviderBinary(resolveCommandCodeBinary(binaryPath, platform), env);
  }
  if (!BUILT_IN_PROVIDER_DRIVER_KINDS.includes(entry.driver)) return undefined;
  return binaryPath.length === 0 ? null : yield* resolveProviderBinary(binaryPath, env);
});

/** Whether the first-run provider choice is still pending (false without settings). */
export const providerSelectionPendingNow: Effect.Effect<boolean> = Effect.serviceOption(
  ServerSettingsService,
).pipe(
  Effect.flatMap((service) =>
    Option.isNone(service)
      ? Effect.succeed(false)
      : service.value.getSettings.pipe(
          Effect.map(isProviderSelectionPending),
          Effect.orElseSucceed(() => false),
        ),
  ),
);

/**
 * Why this instance must not be launched now, or `null` when it may be.
 * Checks enabled state first, then (when settings and a filesystem are
 * available) that the executable exists.
 */
export const providerLaunchBlockReason = Effect.fn("providerLaunchBlockReason")(
  function* (instance: {
    readonly instanceId: ProviderInstanceId;
    readonly enabled: boolean;
  }): Effect.fn.Return<string | null> {
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const settings = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(Effect.option)
      : Option.none<ServerSettings>();
    if (!instance.enabled) {
      return Option.isSome(settings) && isProviderSelectionPending(settings.value)
        ? `Provider instance '${instance.instanceId}' is not enabled: choose your agents first.`
        : `Provider instance '${instance.instanceId}' is disabled in ViewCode settings.`;
    }
    if (Option.isNone(settings)) return null;
    const entry = instanceEntry(settings.value, instance.instanceId);
    const fileSystem = yield* Effect.serviceOption(FileSystem.FileSystem);
    const path = yield* Effect.serviceOption(Path.Path);
    if (!entry || Option.isNone(fileSystem) || Option.isNone(path)) return null;
    const executable = yield* resolveInstanceExecutable(entry).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem.value),
      Effect.provideService(Path.Path, path.value),
    );
    return executable === null
      ? `The executable for provider instance '${instance.instanceId}' was not found, so it was not launched. Install it or set its binary path in Settings → Providers.`
      : null;
  },
);

/**
 * Where each built-in provider's executable would be found, by filesystem
 * lookup only. Never spawns. Backs `server.detectProviders`.
 */
export const detectProviders = Effect.fn("detectProviders")(function* (
  settings: ServerSettings,
): Effect.fn.Return<ReadonlyArray<DetectedProvider>, never, FileSystem.FileSystem | Path.Path> {
  return yield* Effect.forEach(
    BUILT_IN_PROVIDER_DRIVER_KINDS,
    (driver) =>
      Effect.gen(function* () {
        const entry = instanceEntry(settings, driver) ?? { driver };
        const executable = yield* resolveInstanceExecutable(
          entry.driver === driver ? entry : { driver },
        );
        // `undefined`: nothing local to find (OpenCode on an external server
        // counts as available) or no way to look (Antigravity without its
        // installation service).
        const path = executable ?? null;
        const installed = path !== null || (executable === undefined && driver === "opencode");
        return { driver, installed, path } satisfies DetectedProvider;
      }),
    { concurrency: "unbounded" },
  );
});
