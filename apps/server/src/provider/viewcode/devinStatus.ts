/**
 * Devin CLI health check: `devin --version`, then `devin models list`, which
 * both lists the account's models and tells whether Devin is signed in.
 * Neither starts a Devin session.
 *
 * @module DevinProvider
 */
import {
  type CustomModelSetting,
  DEVIN_DEFAULT_MODEL,
  type DevinSettings,
  type ModelCapabilities,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  DEVIN_API_KEY_ENV,
  DEVIN_NOT_SIGNED_IN_MESSAGE,
  devinCommand,
  parseDevinModelList,
} from "./devinAcpSupport.ts";
import {
  AUTH_PROBE_TIMEOUT_MS,
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "@t3tools/provider-core/server/snapshotProbe";

const DEVIN_PRESENTATION = {
  displayName: "Devin",
  badgeLabel: "Early Access",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const satisfies ServerProviderPresentation;

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_MODEL: ServerProviderModel = {
  slug: DEVIN_DEFAULT_MODEL,
  name: "Devin default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

function devinModels(
  customModels: ReadonlyArray<CustomModelSetting>,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [DEFAULT_MODEL, ...discovered],
    customModels,
    EMPTY_CAPABILITIES,
  );
}

const runDevin = (
  settings: DevinSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = devinCommand(settings);
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/** Sign-in state and models from one `devin models list` run. */
function readDevinModelsProbe(output: {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}): { readonly auth: ServerProviderAuth; readonly models: ReadonlyArray<ServerProviderModel> } {
  if (output.code === 0) {
    return {
      auth: { status: "authenticated", type: "cached_token", label: "Devin account" },
      models: parseDevinModelList(output.stdout),
    };
  }
  return {
    auth: /not logged in/i.test(`${output.stdout}\n${output.stderr}`)
      ? { status: "unauthenticated" }
      : { status: "unknown" },
    models: [],
  };
}

export function buildInitialDevinProviderSnapshot(
  settings: DevinSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: devinModels(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Devin CLI availability..."
          : "Devin is disabled in ViewCode settings.",
      },
    }),
  );
}

export const checkDevinProviderStatus = Effect.fn("checkDevinProviderStatus")(function* (
  settings: DevinSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const snapshot = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models = devinModels(settings.customModels),
  ) =>
    buildServerProvider({
      presentation: DEVIN_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      slashCommands: [COMPACT_SLASH_COMMAND],
      probe,
    });

  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Devin is disabled in ViewCode settings.",
    });
  }

  const versionResult = yield* runDevin(settings, ["--version"], environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );
  if (Result.isFailure(versionResult)) {
    const missing = isCommandMissingCause(versionResult.failure);
    return snapshot({
      installed: !missing,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: missing
        ? "Devin CLI (`devin`) is not installed or not on PATH."
        : "Failed to execute Devin CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success) || versionResult.success.value.code !== 0) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: Option.isNone(versionResult.success)
        ? "Devin CLI is installed but timed out while running `devin --version`."
        : "Devin CLI is installed but failed to run.",
    });
  }
  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);

  const listed = yield* runDevin(
    settings,
    ["models", "list", "--format", "json"],
    environment,
  ).pipe(
    Effect.timeoutOption(AUTH_PROBE_TIMEOUT_MS),
    Effect.map(Option.map(readDevinModelsProbe)),
    Effect.orElseSucceed(() => Option.none()),
  );
  const probe = Option.getOrElse(listed, () => ({
    auth: { status: "unknown" } as ServerProviderAuth,
    models: [] as ReadonlyArray<ServerProviderModel>,
  }));
  const auth: ServerProviderAuth =
    probe.auth.status !== "authenticated" && environment[DEVIN_API_KEY_ENV]?.trim()
      ? { status: "authenticated", type: "api_key", label: "Windsurf API key" }
      : probe.auth;

  return snapshot(
    {
      installed: true,
      version,
      status: auth.status === "unauthenticated" ? "warning" : "ready",
      auth,
      ...(auth.status === "unauthenticated"
        ? { message: DEVIN_NOT_SIGNED_IN_MESSAGE }
        : auth.status === "unknown"
          ? { message: "Devin is installed, but its model list could not be read." }
          : {}),
    },
    devinModels(settings.customModels, probe.models),
  );
});
