import {
  type DetectedProvider,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as AntigravityInstallation from "../AntigravityInstallation.ts";

const COMMANDS: Readonly<Record<string, string>> = {
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

/** First-run discovery only reads executable files. It must never probe a disabled provider. */
export const detectProviders = Effect.fn("ViewCode.detectProviders")(function* (
  settings: ServerSettings,
) {
  const platform = yield* HostProcess.Platform;
  const home = yield* HostProcess.HomeDirectory;
  const hostEnv = yield* HostProcess.Environment;
  const resolve = yield* SpawnExecutableResolution;
  const antigravity = yield* Effect.serviceOption(AntigravityInstallation.AntigravityInstallation);
  return yield* Effect.forEach(
    Object.entries(COMMANDS),
    ([name, defaultCommand]) =>
      Effect.gen(function* () {
        const driver = ProviderDriverKind.make(name);
        const entry = settings.providerInstances[ProviderInstanceId.make(name)];
        const config =
          entry?.driver === driver && typeof entry.config === "object" && entry.config !== null
            ? (entry.config as { readonly binaryPath?: unknown; readonly serverUrl?: unknown })
            : {};
        const env = yield* mergeProviderInstanceEnvironment(entry?.environment, hostEnv);
        const configured = typeof config.binaryPath === "string" ? config.binaryPath.trim() : "";
        const command = expandHomePath(configured || defaultCommand, home);
        if (driver === "antigravity" && Option.isSome(antigravity)) {
          const path = yield* antigravity.value.resolve(configured, env).pipe(
            Effect.map((executable) => executable.executablePath),
            Effect.orElseSucceed(() => null),
          );
          return { driver, path, installed: path !== null } satisfies DetectedProvider;
        }
        // Cursor's v2 runtime is the bundled SDK. Remote OpenCode needs no local executable.
        if (
          driver === "cursor" ||
          (driver === "opencode" && typeof config.serverUrl === "string" && config.serverUrl.trim())
        ) {
          return { driver, path: null, installed: true } satisfies DetectedProvider;
        }
        const path = command ? (resolve(command, platform, env) ?? null) : null;
        return { driver, path, installed: path !== null } satisfies DetectedProvider;
      }),
    { concurrency: "unbounded" },
  );
});
