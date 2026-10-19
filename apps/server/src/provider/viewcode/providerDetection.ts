import {
  type DetectedProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";
import { resolveCommandCodeBinary } from "../commandCodeCli.ts";

const COMMANDS: Readonly<Record<string, string | undefined>> = {
  codex: "codex",
  claudeAgent: "claude",
  cursor: "",
  grok: "grok",
  opencode: "opencode",
  antigravity: "",
  pi: "pi",
  muse: "muse",
  commandCode: "cmd",
  droid: "droid",
  devin: "devin",
};

/**
 * Where an instance's executable is, by an uncached filesystem lookup only: the configured path,
 * else the driver's command on PATH with the instance's environment. Never spawns. `undefined`
 * when the instance runs no executable of its own to look up (Cursor's bundled SDK, remote
 * OpenCode, managed Codex) or there is no way to look (an unknown driver, Antigravity without its
 * installation service).
 */
export const resolveInstanceExecutable = Effect.fn("ViewCode.resolveInstanceExecutable")(function* (
  driver: ProviderDriverKind,
  entry: ProviderInstanceConfig | undefined,
) {
  const defaultCommand = Object.hasOwn(COMMANDS, driver) ? COMMANDS[driver] : undefined;
  if (defaultCommand === undefined) return undefined;
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnv = yield* HostProcess.Environment;
  const resolve = yield* SpawnExecutableResolution;
  const config =
    entry?.driver === driver && typeof entry.config === "object" && entry.config !== null
      ? (entry.config as {
          readonly binaryPath?: unknown;
          readonly serverUrl?: unknown;
          readonly setupMode?: unknown;
        })
      : {};
  // Managed Codex runs the copy ViewCode installs itself, not one on PATH.
  if (driver === "codex" && config.setupMode === "managed") return undefined;
  const env = yield* mergeProviderInstanceEnvironment(entry?.environment, hostEnv);
  const configured = typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
  if (driver === "antigravity") {
    const antigravity = yield* Effect.serviceOption(
      AntigravityInstallation.AntigravityInstallation,
    );
    if (Option.isNone(antigravity)) return undefined;
    return yield* antigravity.value.resolve(configured, env).pipe(
      Effect.map((executable): string | null => executable.executablePath),
      Effect.orElseSucceed(() => null),
    );
  }
  // Cursor's v2 runtime is the bundled SDK. Remote OpenCode needs no local executable.
  if (
    driver === "cursor" ||
    (driver === "opencode" && typeof config.serverUrl === "string" && config.serverUrl.trim())
  ) {
    return undefined;
  }
  const command = expandHomePath(
    driver === "commandCode"
      ? resolveCommandCodeBinary(configured, platform)
      : configured || defaultCommand,
    home,
  );
  return command ? (resolve(command, platform, env) ?? null) : null;
});

/** First-run discovery only reads executable files. It must never probe a disabled provider. */
export const detectProviders = Effect.fn("ViewCode.detectProviders")(function* (
  settings: ServerSettings,
) {
  return yield* Effect.forEach(
    Object.keys(COMMANDS),
    (name) =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make(name);
        const path = yield* resolveInstanceExecutable(
          driver,
          settings.providerInstances[ProviderInstanceId.make(name)],
        );
        return {
          driver,
          path: path ?? null,
          installed: path === undefined ? driver !== "antigravity" : path !== null,
        } satisfies DetectedProvider;
      }),
    { concurrency: "unbounded" },
  );
});
