/**
 * Factory Droid health check: `droid --version`, the stored login or API key,
 * and the model list `droid exec -m <unknown>` prints. None of it starts a
 * Droid session.
 *
 * @module DroidProvider
 */
import {
  type CustomModelSetting,
  DROID_DEFAULT_MODEL,
  type ModelCapabilities,
  type DroidSettings,
  type ServerProviderAuth,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "@t3tools/provider-core/server/snapshotProbe";
import {
  droidCommand,
  DROID_NOT_SIGNED_IN_MESSAGE,
  hasDroidApiKey,
  parseDroidModelList,
} from "./droidAcpSupport.ts";

const DROID_PRESENTATION = {
  displayName: "Droid",
  badgeLabel: "Early Access",
  supportsConversationRollback: false,
  // Plan maps to Droid's read-only spec mode.
  showInteractionModeToggle: true,
} as const satisfies ServerProviderPresentation;

const VERSION_PROBE_TIMEOUT_MS = 8_000;
const MODEL_LIST_TIMEOUT_MS = 15_000;
/** Not a model id, so Droid lists the ones it has and exits. */
const MODEL_LIST_SENTINEL = "?";
/** Files Droid keeps a login in under `~/.factory` (keyfile, keyring marker, legacy). */
const DROID_LOGIN_FILES = [
  "auth.v2.file",
  "auth.v2.keyring",
  "auth.v2.loginkeychain",
  "auth.encrypted",
  "auth.json",
];

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });
const DEFAULT_MODEL: ServerProviderModel = {
  slug: DROID_DEFAULT_MODEL,
  name: "Droid default",
  isCustom: false,
  isDefault: true,
  capabilities: EMPTY_CAPABILITIES,
};

function droidModels(
  customModels: ReadonlyArray<CustomModelSetting>,
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    [DEFAULT_MODEL, ...discovered],
    customModels,
    EMPTY_CAPABILITIES,
  );
}

const runDroid = (
  settings: DroidSettings,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = droidCommand(settings);
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

/** True when Droid has a stored login; Droid reads `~/.factory` under `FACTORY_HOME_OVERRIDE`. */
const hasStoredDroidLogin = (environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home =
      environment.FACTORY_HOME_OVERRIDE?.trim() ||
      environment.HOME?.trim() ||
      environment.USERPROFILE?.trim();
    if (!home) return false;
    const checks = yield* Effect.forEach(DROID_LOGIN_FILES, (name) =>
      fileSystem.exists(path.join(home, ".factory", name)).pipe(Effect.orElseSucceed(() => false)),
    );
    return checks.some(Boolean);
  });

export function buildInitialDroidProviderSnapshot(
  settings: DroidSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: settings.enabled,
      checkedAt: DateTime.formatIso(now),
      models: droidModels(settings.customModels),
      probe: {
        installed: settings.enabled,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: settings.enabled
          ? "Checking Droid CLI availability..."
          : "Droid is disabled in ViewCode settings.",
      },
    }),
  );
}

export const checkDroidProviderStatus = Effect.fn("checkDroidProviderStatus")(function* (
  settings: DroidSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<
  ServerProviderDraft,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const fallbackModels = droidModels(settings.customModels);
  const snapshot = (
    probe: Parameters<typeof buildServerProvider>[0]["probe"],
    models = fallbackModels,
  ) =>
    buildServerProvider({
      presentation: DROID_PRESENTATION,
      enabled: settings.enabled,
      checkedAt,
      models,
      probe,
    });

  if (!settings.enabled) {
    return snapshot({
      installed: false,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: "Droid is disabled in ViewCode settings.",
    });
  }

  const versionResult = yield* runDroid(settings, ["--version"], environment).pipe(
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
        ? "Droid CLI (`droid`) is not installed or not on PATH."
        : "Failed to execute Droid CLI health check.",
    });
  }
  if (Option.isNone(versionResult.success) || versionResult.success.value.code !== 0) {
    return snapshot({
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      message: Option.isNone(versionResult.success)
        ? "Droid CLI is installed but timed out while running `droid --version`."
        : "Droid CLI is installed but failed to run.",
    });
  }
  const output = versionResult.success.value;
  const version = parseGenericCliVersion(`${output.stdout}\n${output.stderr}`);

  const listed = yield* runDroid(settings, ["exec", "-m", MODEL_LIST_SENTINEL], environment).pipe(
    Effect.timeoutOption(MODEL_LIST_TIMEOUT_MS),
    Effect.map(Option.map((result) => parseDroidModelList(`${result.stderr}\n${result.stdout}`))),
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<ServerProviderModel>>()),
  );
  const discovered = Option.getOrElse(listed, () => []);
  const models = droidModels(settings.customModels, discovered);

  const auth: ServerProviderAuth = hasDroidApiKey(environment)
    ? { status: "authenticated", type: "api_key", label: "Factory API key" }
    : (yield* hasStoredDroidLogin(environment))
      ? { status: "authenticated", type: "cached_token", label: "Factory account" }
      : { status: "unauthenticated" };

  return snapshot(
    {
      installed: true,
      version,
      status: auth.status === "authenticated" ? "ready" : "warning",
      auth,
      ...(auth.status === "authenticated"
        ? discovered.length === 0
          ? { message: "Droid is installed, but its model list could not be read." }
          : {}
        : { message: DROID_NOT_SIGNED_IN_MESSAGE }),
    },
    models,
  );
});
