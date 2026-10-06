/**
 * ViewCode: add a Codex or Claude account and prepare its sign-in terminal.
 *
 * Accounts are ordinary provider instances in `settings.providerInstances`;
 * this module only fills in their home paths and makes sure those
 * directories exist on the server before the login runs. The sign-in itself
 * is a normal terminal opened with `providerInstanceId`, which applies the
 * instance's CODEX_HOME / CLAUDE_CONFIG_DIR (`terminal/Manager.ts`).
 */
import {
  ClaudeSettings,
  CodexSettings,
  ProviderAccountError,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderAccountAddInput,
  type ProviderAccountAddResult,
  type ProviderAccountSignInPlan,
  type ProviderInstanceConfig,
  type ServerSettings,
  type ServerSettingsError,
} from "@t3tools/contracts";
import {
  accountLoginCommand,
  existingDirectoryAccountConfig,
  isAccountDriver,
  managedAccountConfig,
  validateAccountInstanceId,
} from "@t3tools/shared/providerAccounts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { expandHomePath } from "../pathExpansion.ts";
import { materializeCodexShadowHome, resolveCodexHomeLayout } from "./Drivers/CodexHomeLayout.ts";
import { resolveClaudeHomePath } from "./Drivers/ClaudeHome.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";

const decodeCodexSettings = Schema.decodeUnknownOption(CodexSettings);
const decodeClaudeSettings = Schema.decodeUnknownOption(ClaudeSettings);

const isProviderAccountError = Schema.is(ProviderAccountError);

const fail = (operation: string, detail: string, cause?: unknown) =>
  new ProviderAccountError({ operation, detail, ...(cause !== undefined ? { cause } : {}) });

/** The settings patch that adds the account, merged into the current instance map. */
export function addAccountSettingsPatch(input: {
  readonly settings: ServerSettings;
  readonly account: ProviderAccountAddInput;
  readonly stateDir: string;
  readonly platform?: string;
}): {
  readonly patch: Pick<ServerSettings, "providerInstances">;
  readonly result: ProviderAccountAddResult;
} {
  const { account, settings } = input;
  const existing = new Set(Object.keys(deriveProviderInstanceConfigMap(settings)));
  const idError = validateAccountInstanceId(account.instanceId, existing);
  if (idError !== null) throw fail("add", idError);

  // Share whatever CODEX_HOME the default Codex instance uses, so the new
  // account can continue that account's threads.
  const defaultCodex = deriveProviderInstanceConfigMap(settings)[ProviderInstanceId.make("codex")];
  const sharedCodexHome = Option.match(decodeCodexSettings(defaultCodex?.config ?? {}), {
    onNone: () => "",
    onSome: (config) => config.homePath,
  });
  const paths: { readonly homePath: string; readonly shadowHomePath?: string } =
    account.existingDirectory
    ? existingDirectoryAccountConfig(account.driver, account.existingDirectory)
    : managedAccountConfig({
        driver: account.driver,
        instanceId: account.instanceId,
        stateDir: input.stateDir,
        sharedCodexHome,
        platform: input.platform,
      });
  const instance: ProviderInstanceConfig = {
    driver: ProviderDriverKind.make(account.driver),
    displayName: account.displayName,
    ...(account.accentColor ? { accentColor: account.accentColor } : {}),
    enabled: true,
    config: paths,
  };
  return {
    patch: {
      providerInstances: { ...settings.providerInstances, [account.instanceId]: instance },
    },
    result: {
      instanceId: account.instanceId,
      homePath: paths.homePath,
      ...(paths.shadowHomePath ? { shadowHomePath: paths.shadowHomePath } : {}),
    },
  };
}

const makePrivateDirectory = Effect.fn("providerAccounts.makePrivateDirectory")(function* (
  directory: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem
    .makeDirectory(directory, { recursive: true, mode: 0o700 })
    .pipe(
      Effect.mapError((cause) =>
        fail("prepareSignIn", `Could not create ${directory} on the server.`, cause),
      ),
    );
});

export const addProviderAccount = Effect.fn("providerAccounts.add")(function* (input: {
  readonly settings: ServerSettings;
  readonly account: ProviderAccountAddInput;
  readonly stateDir: string;
  readonly updateSettings: (
    patch: Pick<ServerSettings, "providerInstances">,
  ) => Effect.Effect<unknown, ServerSettingsError>;
}) {
  const { patch, result } = yield* Effect.try({
    try: () =>
      addAccountSettingsPatch({
        settings: input.settings,
        account: input.account,
        stateDir: input.stateDir,
        platform: process.platform,
      }),
    catch: (cause) =>
      isProviderAccountError(cause) ? cause : fail("add", "Could not add the account.", cause),
  });
  // A managed home is ours to create; an existing directory must already be there.
  const managedHome = input.account.existingDirectory
    ? undefined
    : (result.shadowHomePath ?? result.homePath);
  if (managedHome) yield* makePrivateDirectory(managedHome);
  yield* input
    .updateSettings(patch)
    .pipe(Effect.mapError((cause) => fail("add", "Could not save the account.", cause)));
  return result;
});

/**
 * Make the instance's home ready for a login and return the terminal plan:
 * an empty working directory (so the CLI never trusts or reads a project)
 * and the login command for the instance's binary.
 */
export const prepareProviderAccountSignIn = Effect.fn("providerAccounts.prepareSignIn")(
  function* (input: {
    readonly settings: ServerSettings;
    readonly instanceId: ProviderInstanceId;
    readonly stateDir: string;
  }) {
    const path = yield* Path.Path;
    const instance = deriveProviderInstanceConfigMap(input.settings)[input.instanceId];
    if (instance === undefined) {
      return yield* fail("prepareSignIn", `No provider instance '${input.instanceId}'.`);
    }
    const driver = String(instance.driver);
    if (!isAccountDriver(driver)) {
      return yield* fail("prepareSignIn", "Sign in from Settings supports Codex and Claude.");
    }

    let binaryPath = "";
    if (driver === "codex") {
      const config = decodeCodexSettings(instance.config ?? {});
      if (Option.isNone(config)) {
        return yield* fail("prepareSignIn", "This Codex instance's settings could not be read.");
      }
      binaryPath = config.value.binaryPath;
      const layout = yield* resolveCodexHomeLayout(config.value);
      if (layout.mode === "authOverlay") {
        // The shadow home must link the shared state before `codex login`
        // writes auth.json into it, exactly as a session would prepare it.
        yield* materializeCodexShadowHome(layout).pipe(
          Effect.mapError((cause) =>
            fail("prepareSignIn", `Could not prepare the Codex shadow home: ${cause.message}`, cause),
          ),
        );
      } else if (layout.effectiveHomePath) {
        yield* makePrivateDirectory(layout.effectiveHomePath);
      }
    } else {
      const config = decodeClaudeSettings(instance.config ?? {});
      if (Option.isNone(config)) {
        return yield* fail("prepareSignIn", "This Claude instance's settings could not be read.");
      }
      binaryPath = config.value.binaryPath;
      if (config.value.homePath.trim().length > 0) {
        yield* makePrivateDirectory(yield* resolveClaudeHomePath(config.value));
      }
    }

    const cwd = path.join(input.stateDir, "provider-sign-in", input.instanceId);
    yield* makePrivateDirectory(cwd);
    const plan: ProviderAccountSignInPlan = {
      instanceId: input.instanceId,
      cwd: path.resolve(expandHomePath(cwd)),
      command: accountLoginCommand({
        driver,
        binaryPath,
        platform: process.platform === "win32" ? "windows" : "posix",
      }),
    };
    return plan;
  },
);
