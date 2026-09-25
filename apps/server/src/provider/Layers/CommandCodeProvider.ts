import {
  COMMAND_CODE_DEFAULT_MODEL,
  type CommandCodeSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, type ChildProcessSpawner } from "effect/unstable/process";

import {
  commandCodeModelsFromList,
  parseCommandCodeModelList,
  parseCommandCodeStatus,
  resolveCommandCodeBinary,
} from "../commandCodeCli.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PRESENTATION = {
  displayName: "Command Code",
  supportsConversationRollback: false,
  badgeLabel: "Early Access",
  showInteractionModeToggle: false,
} as const;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const VERSION_PROBE_TIMEOUT_MS = 8_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;

const FALLBACK_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: COMMAND_CODE_DEFAULT_MODEL,
    name: "Default",
    isCustom: false,
    isDefault: true,
    capabilities: null,
  },
];

function modelsWithCustom(
  settings: CommandCodeSettings,
  builtIn: ReadonlyArray<ServerProviderModel> = FALLBACK_MODELS,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(builtIn, settings.customModels, EMPTY_CAPABILITIES);
}

const runCommandCode = (
  settings: CommandCodeSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const binary = resolveCommandCodeBinary(settings.binaryPath, yield* HostProcessPlatform);
    const spawnCommand = yield* resolveSpawnCommand(binary, args, { env: environment });
    return yield* spawnAndCollect(
      binary,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
        // `cmd` without a TTY would otherwise wait on stdin for a prompt.
        stdin: "ignore",
      }),
    );
  });

const disabledSnapshot = (settings: CommandCodeSettings, checkedAt: string) =>
  buildServerProvider({
    presentation: PRESENTATION,
    enabled: false,
    checkedAt,
    models: modelsWithCustom(settings),
    probe: {
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Command Code is disabled. It turns on when `cmd` is on PATH, or enable it here.",
    },
  });

export const buildInitialCommandCodeSnapshot = (
  settings: CommandCodeSettings,
): Effect.Effect<ServerProviderDraft> =>
  Effect.gen(function* () {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) return disabledSnapshot(settings, checkedAt);
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models: modelsWithCustom(settings),
      probe: {
        installed: true,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Checking Command Code CLI availability...",
      },
    });
  });

export const checkCommandCodeProviderStatus = Effect.fn("checkCommandCodeProviderStatus")(
  function* (
    settings: CommandCodeSettings,
    environment: NodeJS.ProcessEnv,
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) return disabledSnapshot(settings, checkedAt);
    const fallbackModels = modelsWithCustom(settings);

    const versionResult = yield* runCommandCode(settings, ["--version"], environment).pipe(
      Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(versionResult) || Option.isNone(versionResult.success)) {
      const missing =
        Result.isFailure(versionResult) && isCommandMissingCause(versionResult.failure);
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? "Command Code CLI (`cmd`) is not installed or not on PATH. Install it with `npm i -g command-code`."
            : "Command Code CLI did not answer `cmd --version`.",
        },
      });
    }
    const versionOutput = versionResult.success.value;
    const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
    if (versionOutput.code !== 0) {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models: fallbackModels,
        probe: {
          installed: true,
          version,
          status: "error",
          auth: { status: "unknown" },
          message: "Command Code CLI is installed but failed to run.",
        },
      });
    }

    const [statusResult, modelsResult] = yield* Effect.all(
      [
        runCommandCode(settings, ["status", "--json"], environment).pipe(
          Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
          Effect.option,
        ),
        runCommandCode(settings, ["--list-models"], environment).pipe(
          Effect.timeoutOption(MODEL_LIST_TIMEOUT_MS),
          Effect.option,
        ),
      ],
      { concurrency: "unbounded" },
    );
    const status = Option.flatMap(Option.flatten(statusResult), (output) =>
      Option.fromUndefinedOr(parseCommandCodeStatus(output.stdout)),
    );
    const listed = Option.match(Option.flatten(modelsResult), {
      onNone: () => [],
      onSome: (output) => (output.code === 0 ? parseCommandCodeModelList(output.stdout) : []),
    });
    const models =
      listed.length > 0
        ? modelsWithCustom(settings, commandCodeModelsFromList(listed))
        : fallbackModels;

    const auth: ServerProviderAuth = Option.match(status, {
      onNone: () => ({ status: "unknown" }),
      onSome: (value) =>
        value.authenticated
          ? { status: "authenticated", type: "cached_token", label: "Command Code account" }
          : { status: "unauthenticated" },
    });
    if (auth.status === "unauthenticated") {
      return buildServerProvider({
        presentation: PRESENTATION,
        enabled: true,
        checkedAt,
        models,
        probe: {
          installed: true,
          version,
          status: "error",
          auth,
          message: "Command Code CLI is installed but not logged in. Run `cmd login`.",
        },
      });
    }
    return buildServerProvider({
      presentation: PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: { installed: true, version, status: "ready", auth },
    });
  },
);
