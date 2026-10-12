/**
 * ViewCode: one launch check for provider work outside health probes.
 *
 * A provider may be launched only when its instance is enabled and its
 * executable resolves on the filesystem. Health probes get the same rule from
 * `guardMissingProviderBinary`; sessions (new and recovered), text generation
 * and sign-in call `providerLaunchBlockReason` before starting anything.
 *
 * @module provider/providerLaunch
 */
import {
  DEFAULT_SERVER_SETTINGS,
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

/** Built-in drivers: the keys of the legacy `providers` settings. */
const BUILT_IN_PROVIDER_DRIVER_KINDS: ReadonlySet<string> = new Set(
  Object.keys(DEFAULT_SERVER_SETTINGS.providers),
);

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
  if (!BUILT_IN_PROVIDER_DRIVER_KINDS.has(entry.driver)) return undefined;
  return binaryPath.length === 0 ? null : yield* resolveProviderBinary(binaryPath, env);
});

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
    if (!instance.enabled) {
      return `Provider instance '${instance.instanceId}' is disabled in ViewCode settings.`;
    }
    const settingsService = yield* Effect.serviceOption(ServerSettingsService);
    const settings = Option.isSome(settingsService)
      ? yield* settingsService.value.getSettings.pipe(Effect.option)
      : Option.none<ServerSettings>();
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
