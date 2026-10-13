/**
 * Pi health check: `pi --version`, then a short-lived `pi --mode rpc
 * --no-session` that reads the user's models and commands. Everything the user
 * configured in `~/.pi/agent` (providers, models.json, extensions, skills)
 * shows up without a hardcoded catalog.
 *
 * @module PiProvider
 */
import {
  type CustomModelSetting,
  PI_DEFAULT_MODEL,
  type PiSettings,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import { compareSemverVersions } from "@t3tools/shared/semver";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import {
  EMPTY_PI_CAPABILITIES,
  MINIMUM_PI_VERSION,
  PI_COMPACT_SLASH_COMMAND,
  parsePiCommands,
  parsePiModels,
} from "../piRpc.ts";
import { makePiRpcConnection } from "../piRpcConnection.ts";
import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "../providerSnapshot.ts";

const PI_PRESENTATION = {
  displayName: "Pi",
  badgeLabel: "Early Access",
  supportsConversationRollback: false,
  // A message sent mid-turn is a native `steer`.
  supportsTurnSteering: true,
  reportsContextWindow: true,
  showInteractionModeToggle: false,
} as const satisfies ServerProviderPresentation;

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const DISCOVERY_TIMEOUT_MS = 15_000;
const DEFAULT_MODEL: ServerProviderModel = {
  slug: PI_DEFAULT_MODEL,
  name: "Pi default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_PI_CAPABILITIES,
};

export const PI_NOT_SIGNED_IN_MESSAGE =
  "Pi has no usable models. Run `pi` in a terminal and use /login, or set a provider API key in this provider's environment.";

function piModels(
  customModels: ReadonlyArray<CustomModelSetting>,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [DEFAULT_MODEL, ...discovered],
    customModels,
    EMPTY_PI_CAPABILITIES,
  );
}

export function piCommand(settings: Pick<PiSettings, "binaryPath">): string {
  return settings.binaryPath.trim() || "pi";
}

/** Pi 1.0.4 added `--no-mcp`; older versions reject unknown flags. */
const PI_NO_MCP_VERSION = "1.0.4";

/** Models, commands and skills from a throwaway RPC session that starts no MCP servers. */
const discoverPi = (settings: PiSettings, environment: NodeJS.ProcessEnv, version: string) =>
  Effect.gen(function* () {
    const connection = yield* makePiRpcConnection({
      command: piCommand(settings),
      args: [
        "--mode",
        "rpc",
        "--no-session",
        "--offline",
        ...(compareSemverVersions(version, PI_NO_MCP_VERSION) >= 0 ? ["--no-mcp"] : []),
      ],
      env: environment,
    });
    yield* Stream.fromQueue(connection.events).pipe(
      Stream.runDrain,
      Effect.ignore,
      Effect.forkScoped,
    );
    const state = yield* connection.request({ type: "get_state" });
    const models = yield* connection.request({ type: "get_available_models" });
    const commands = yield* connection
      .request({ type: "get_commands" })
      .pipe(Effect.orElseSucceed(() => undefined));
    return { models: parsePiModels(models, state), ...parsePiCommands(commands) };
  }).pipe(Effect.scoped);

export function buildInitialPiProviderSnapshot(
  settings: PiSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: piModels(settings.customModels),
      slashCommands: [PI_COMPACT_SLASH_COMMAND],
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Pi availability..."
          : "Pi is disabled in ViewCode settings.",
      },
    }),
  );
}

export const checkPiProviderStatus = Effect.fn("checkPiProviderStatus")(function* (
  settings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    discovered?: Effect.Success<ReturnType<typeof discoverPi>>,
  ) =>
    buildServerProvider({
      presentation: PI_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models: piModels(settings.customModels, discovered?.models),
      slashCommands: discovered?.slashCommands ?? [PI_COMPACT_SLASH_COMMAND],
      skills: discovered?.skills ?? [],
      probe,
    });

  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Pi is disabled in ViewCode settings.",
    });
  }

  const versionResult = yield* Effect.gen(function* () {
    const command = piCommand(settings);
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  }).pipe(Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS), Effect.result);
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Pi (`pi`) is not installed or not on PATH. Install it with `npm install -g @earendil-works/pi-coding-agent`."
        : "Failed to execute Pi health check.",
    });
  }
  if (Option.isNone(versionResult.success) || versionResult.success.value.code !== 0) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: Option.isNone(versionResult.success)
        ? "Pi is installed but timed out while running `pi --version`."
        : "Pi is installed but failed to run.",
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);
  if (version === null || compareSemverVersions(version, MINIMUM_PI_VERSION) < 0) {
    return snapshot({
      installed: true,
      version,
      status: "error",
      auth: { status: "unknown" },
      message: `ViewCode needs Pi ${MINIMUM_PI_VERSION} or newer. Update it with \`pi update self\`.`,
    });
  }

  const discovery = yield* discoverPi(settings, environment, version).pipe(
    Effect.timeoutOption(DISCOVERY_TIMEOUT_MS),
    Effect.exit,
  );
  if (Exit.isFailure(discovery) || Option.isNone(discovery.value)) {
    yield* Effect.logWarning("Pi RPC discovery failed.", {
      errorTag: Exit.isFailure(discovery) ? causeErrorTag(discovery.cause) : "Timeout",
    });
    return snapshot({
      installed: true,
      version,
      status: "warning",
      auth: { status: "unknown" },
      message: "Pi is installed, but its models could not be read.",
    });
  }
  const discovered = discovery.value.value;
  const signedIn = discovered.models.length > 0;
  return snapshot(
    {
      installed: true,
      version,
      status: signedIn ? "ready" : "warning",
      auth: signedIn ? { status: "authenticated", type: "pi" } : { status: "unauthenticated" },
      ...(signedIn ? {} : { message: PI_NOT_SIGNED_IN_MESSAGE }),
    },
    discovered,
  );
});
