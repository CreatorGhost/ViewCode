/**
 * ViewCode's Cursor driver: one Cursor provider with two runtimes.
 *
 * `sdk` is upstream's driver unchanged (`@cursor/sdk` inside the server).
 * `cursor-agent` runs Cursor's own CLI over the native ACP adapter, so the
 * server's only Cursor child is the signed `cursor-agent`; its tools are that
 * process's children. See `cursorRuntime.ts` for the default.
 *
 * @module ViewCodeCursorDriver
 */
import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { CursorDriver } from "@t3tools/provider-cursor/server";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import type * as CursorUsageAccounts from "@t3tools/provider-cursor/server/CursorUsageAccounts";
import { readCursorUsageLimits } from "@t3tools/provider-cursor/server/usageLimits";
import { probeCursorSkills } from "@t3tools/provider-cursor/server/skills";
import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makeAcpAdapterV2, type AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderDriverCreateInput,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import { ViewCodeAcpCapabilities, type ViewCodeAcpDriverEnv } from "./acpDrivers.ts";
import { makeAcpTextGeneration } from "./acpTextGeneration.ts";
import {
  applyCursorAgentModel,
  configureCursorAgentMode,
  CURSOR_AGENT_CLIENT_META,
  cursorAgentBaseModelId,
  CursorAgentModelDiscoveryError,
  cursorAgentPromptAuthProblem,
  cursorAgentPromptFailure,
  listCursorAgentModels,
  makeCursorAgentAcpRuntime,
  registerCursorAgentExtensions,
} from "./cursorAgentAcpSupport.ts";
import { makeCursorAgentAuth } from "./cursorAgentAuth.ts";
import {
  buildInitialCursorAgentSnapshot,
  checkCursorAgentProviderStatus,
  type CursorAgentAbout,
} from "./cursorAgentStatus.ts";
import { cursorCliLoginIdentity } from "./cursorCredentialStore.ts";
import { effectiveCursorRuntime } from "./cursorRuntime.ts";

const DRIVER_KIND = ProviderDriverKind.make("cursor");
const isCursorAgentModelDiscoveryError = Schema.is(CursorAgentModelDiscoveryError);
const MODEL_CACHE_TTL = Duration.minutes(30);

export type CursorAgentDriverEnv =
  | ViewCodeAcpDriverEnv
  | HttpClient.HttpClient
  | CursorKeychain.CursorKeychain;

/**
 * Full access launches with `--force` only when no explicit approval or sandbox
 * override asks for prompts, as Grok does with its always-approve flag.
 */
function cursorAgentLaunchRuntimeMode(
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy,
) {
  return runtimePolicy.approvalPolicy === undefined && runtimePolicy.sandboxPolicy === undefined
    ? runtimePolicy.runtimeMode
    : "approval-required";
}

const createCursorAgentInstance = (input: ProviderDriverCreateInput<CursorSettings>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const httpClient = yield* HttpClient.HttpClient;
    const keychain = yield* CursorKeychain.CursorKeychain;
    const host = yield* ProviderHost.ProviderHost;
    const environment = yield* mergeProviderInstanceEnvironment(input.environment);
    const settings = { ...input.config, enabled: input.enabled } satisfies CursorSettings;
    const continuationIdentity = defaultProviderContinuationIdentity({
      driverKind: DRIVER_KIND,
      instanceId: input.instanceId,
    });
    const stampIdentity = withInstanceIdentity({
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      displayName: input.displayName ?? "Cursor",
      accentColor: input.accentColor,
      continuationGroupKey: continuationIdentity.continuationKey,
    });
    const selfInvocation = yield* resolveSelfInvocation();
    const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
    const nativeLogger = yield* makeAcpNativeLoggerFactory();
    const instanceScope = yield* Effect.scope;
    // A turn is the user asking, so this re-check does not wait for the
    // background policy that paces the periodic status refresh.
    const recheckStatus = Effect.suspend(() => snapshot.refresh).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkIn(instanceScope),
      Effect.asVoid,
    );
    const recheckAfterAuthProblem = (cause: unknown) => {
      const problem = cursorAgentPromptAuthProblem(cause);
      return problem === undefined
        ? Effect.succeed(false)
        : Effect.logWarning("Cursor CLI lost its sign-in or connection; replacing the process", {
            problem,
          }).pipe(Effect.andThen(recheckStatus), Effect.as(true));
    };
    const flavor: AcpAdapterV2Flavor = {
      driver: DRIVER_KIND,
      runtimeHarness: "Cursor CLI",
      capabilities: {
        ...ViewCodeAcpCapabilities,
        threads: { ...ViewCodeAcpCapabilities.threads, canRollbackThread: false },
      },
      clientCapabilitiesMeta: CURSOR_AGENT_CLIENT_META,
      promptFailure: cursorAgentPromptFailure,
      restartRuntimeAfterPromptFailure: recheckAfterAuthProblem,
      withRuntimeStartup: (startup) => startup.pipe(Effect.tapError(recheckAfterAuthProblem)),
      resolveModelId: (selection) => cursorAgentBaseModelId(selection.model),
      applyModelSelection: ({ runtime, modelSelection }) =>
        applyCursorAgentModel(runtime, modelSelection.model),
      configureRuntimePolicy: configureCursorAgentMode,
      registerExtensions: registerCursorAgentExtensions,
      makeRuntime: ({ runtimePolicy, mcpSession, processEnvironment, ...runtimeInput }) =>
        makeCursorAgentAcpRuntime({
          ...runtimeInput,
          settings,
          environment: withAgentDeviceEnvironment(
            { ...environment, ...processEnvironment },
            mcpSession,
          ),
          childProcessSpawner: spawner,
          runtimeMode: cursorAgentLaunchRuntimeMode(runtimePolicy),
        }),
    };
    const orchestrationAdapter = yield* makeAcpAdapterV2({
      instanceId: input.instanceId,
      flavor,
      selfInvocation,
      nativeLogging: (threadId) =>
        nativeLogger({ nativeEventLogger: loggers.native, provider: DRIVER_KIND, threadId }),
    });

    const makeRuntime = (cwd: string, name: string) =>
      makeCursorAgentAcpRuntime({
        settings,
        environment,
        childProcessSpawner: spawner,
        cwd,
        clientInfo: { name, version: "0.1.0" },
      });
    const textGeneration = yield* makeAcpTextGeneration({
      label: "Cursor",
      makeRuntime: (cwd) => makeRuntime(cwd, "viewcode-text"),
      // Ask mode is read-only, so text generation never edits the workspace.
      configure: (runtime, selection) =>
        applyCursorAgentModel(runtime, selection.model).pipe(
          Effect.andThen(runtime.getModeState),
          Effect.flatMap((modes) =>
            modes?.availableModes.some((mode) => mode.id === "ask") === true
              ? runtime.setMode("ask").pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
    });

    // `session/new` plus the extension call is a full CLI start, so the list is
    // cached until the CLI version or its login changes.
    const models = yield* Cache.makeWith(
      (_key: string) =>
        Effect.gen(function* () {
          const runtime = yield* makeRuntime(host.paths.cwd, "viewcode-provider-probe");
          yield* runtime.start();
          return yield* listCursorAgentModels(runtime);
        }).pipe(
          Effect.scoped,
          Effect.mapError((cause) =>
            isCursorAgentModelDiscoveryError(cause)
              ? cause
              : new CursorAgentModelDiscoveryError({ cause }),
          ),
        ),
      {
        capacity: 1,
        timeToLive: (
          exit: Exit.Exit<ReadonlyArray<ServerProviderModel>, CursorAgentModelDiscoveryError>,
        ) => (Exit.isSuccess(exit) && exit.value.length > 0 ? MODEL_CACHE_TTL : Duration.zero),
      },
    );
    const discoverModels = (about: CursorAgentAbout) =>
      Cache.get(models, JSON.stringify([about.version, about.auth.email ?? null]));

    const auth = yield* makeCursorAgentAuth({
      instanceId: input.instanceId,
      settings,
      environment,
      cwd: host.paths.cwd,
      onChanged: (): Effect.Effect<void> =>
        Cache.invalidateAll(models).pipe(
          Effect.andThen(Effect.suspend(() => snapshot.refresh)),
          Effect.ignore,
        ),
    });

    // The CLI keeps its account in `~/.cursor/cli-config.json` and the token in
    // the Keychain; only the former is read, to tell a lost login from an unread one.
    const hasSavedCliLogin = Effect.gen(function* () {
      const home = environment.HOME?.trim() || (yield* HostProcess.HomeDirectory);
      const config = yield* fileSystem.readFileString(
        path.join(home, ".cursor", "cli-config.json"),
      );
      return yield* Effect.try(() => cursorCliLoginIdentity(config).length > 0);
    }).pipe(Effect.orElseSucceed(() => false));

    const checkProvider = checkCursorAgentProviderStatus(
      settings,
      environment,
      discoverModels,
      hasSavedCliLogin,
    ).pipe(
      Effect.flatMap((draft) =>
        settings.enabled && draft.installed && draft.auth.status === "authenticated"
          ? host.settings.get.pipe(
              Effect.flatMap((serverSettings) =>
                readCursorUsageLimits(
                  settings,
                  environment,
                  serverSettings.cursorKeychainUsageEnabled,
                ),
              ),
              Effect.map((usageLimits) => ({ ...draft, usageLimits })),
              Effect.orElseSucceed(() => draft),
            )
          : Effect.succeed(draft),
      ),
      Effect.map((draft) =>
        stampIdentity({
          ...draft,
          setup: { canAuthenticate: auth.canSignIn, canInstall: false },
          auth: { ...draft.auth, canLogout: draft.auth.status === "authenticated" },
        }),
      ),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.provideService(CursorKeychain.CursorKeychain, keychain),
    );
    const source = yield* makeProviderSnapshotSettingsSource(settings);
    const snapshot = yield* makeManagedServerProvider({
      ...source,
      haveSettingsChanged: haveProviderSnapshotSettingsChanged,
      resolveMaintenance: () =>
        Effect.succeed(
          makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER_KIND,
            packageName: null,
          }),
        ),
      initialSnapshot: (current) =>
        buildInitialCursorAgentSnapshot(current.provider).pipe(Effect.map(stampIdentity)),
      checkProvider,
    });

    return {
      instanceId: input.instanceId,
      driverKind: DRIVER_KIND,
      continuationIdentity,
      displayName: input.displayName,
      accentColor: input.accentColor,
      enabled: input.enabled,
      auth: auth.controller,
      snapshot,
      snapshotForCwd: (cwd) =>
        !settings.enabled
          ? snapshot.getSnapshot
          : Effect.all([snapshot.getSnapshot, probeCursorSkills(cwd, environment)]).pipe(
              Effect.map(([machineSnapshot, skills]) => ({ ...machineSnapshot, skills })),
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.mapError(
                (cause) =>
                  new ProviderDriverError({
                    driver: DRIVER_KIND,
                    instanceId: input.instanceId,
                    detail: `Failed to discover Cursor skills for '${cwd}'`,
                    cause,
                  }),
              ),
            ),
      orchestrationAdapter,
      textGeneration,
    } satisfies ProviderInstance;
  }).pipe(
    Effect.mapError(
      (cause) =>
        new ProviderDriverError({
          driver: DRIVER_KIND,
          instanceId: input.instanceId,
          detail: "Could not create the Cursor CLI provider.",
          cause,
        }),
    ),
  );

/** Wraps upstream's SDK driver; tests pass a stand-in to observe which runtime was built. */
export function makeViewCodeCursorDriver<SdkEnv>(
  sdk: ProviderDriver<CursorSettings, SdkEnv, CursorUsageAccounts.CursorUsageAccounts>,
): ProviderDriver<
  CursorSettings,
  SdkEnv | CursorAgentDriverEnv,
  CursorUsageAccounts.CursorUsageAccounts
> {
  return {
    ...sdk,
    create: (input) =>
      Effect.gen(function* () {
        const environment = yield* mergeProviderInstanceEnvironment(input.environment);
        const runtime = yield* effectiveCursorRuntime(input.config, environment);
        return runtime === "sdk"
          ? yield* sdk.create(input)
          : yield* createCursorAgentInstance(input);
      }),
  };
}

export const ViewCodeCursorDriver = makeViewCodeCursorDriver(CursorDriver);
