import { CommandCodeSettings } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
} from "@t3tools/provider-core/server/driver";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import { withInstanceIdentity } from "@t3tools/provider-core/server/instanceIdentity";
import { mergeProviderInstanceEnvironment } from "@t3tools/provider-core/server/instanceEnvironment";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import {
  makePackageManagedProviderMaintenanceResolver,
  makeCachedProviderMaintenanceResolution,
  resolveProviderMaintenanceCapabilitiesEffect,
} from "@t3tools/provider-core/server/maintenanceResolver";
import {
  haveProviderSnapshotSettingsChanged,
  makeProviderSnapshotSettingsSource,
} from "@t3tools/provider-core/server/snapshotSettings";
import {
  buildInitialCommandCodeSnapshot,
  checkCommandCodeProviderStatus,
} from "./commandCodeStatus.ts";
import { commandCodeUsagePointer, readCommandCodeUsageLimits } from "./commandCodeUsageLimits.ts";
import { COMMAND_CODE_DRIVER, makeCommandCodeAdapterV2 } from "./commandCodeAdapter.ts";
import { makeCommandCodeTextGeneration } from "./commandCodeTextGeneration.ts";

export type CommandCodeDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | FileSystem.FileSystem
  | Path.Path
  | HttpClient.HttpClient
  | ProviderHost.ProviderHost
  | IdAllocator.IdAllocatorV2;
const decodeCommandCodeSettings = Schema.decodeSync(CommandCodeSettings);

export const CommandCodeDriver: ProviderDriver<CommandCodeSettings, CommandCodeDriverEnv> = {
  driverKind: COMMAND_CODE_DRIVER,
  metadata: { displayName: "Command Code", supportsMultipleInstances: true },
  configSchema: CommandCodeSettings,
  defaultConfig: () => decodeCommandCodeSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const driver = COMMAND_CODE_DRIVER;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const httpClient = yield* HttpClient.HttpClient;
      const environment = yield* mergeProviderInstanceEnvironment(input.environment);
      const settings = { ...input.config, enabled: input.enabled };
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: driver,
        instanceId: input.instanceId,
      });
      const stampIdentity = withInstanceIdentity({
        ...input,
        accentColor: input.accentColor,
        driverKind: driver,
        continuationGroupKey: continuationIdentity.continuationKey,
      });
      const orchestrationAdapter = yield* makeCommandCodeAdapterV2({
        instanceId: input.instanceId,
        settings,
        environment,
      });
      const textGeneration = yield* makeCommandCodeTextGeneration(settings, environment);
      const resolver = makePackageManagedProviderMaintenanceResolver({
        provider: driver,
        npmPackageName: "command-code",
        nativeUpdate: null,
      });
      const resolveMaintenance = yield* makeCachedProviderMaintenanceResolution(
        resolveProviderMaintenanceCapabilitiesEffect(resolver, {
          binaryPath: settings.binaryPath,
          env: environment,
        }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
      );
      const source = yield* makeProviderSnapshotSettingsSource(settings);
      const checkProvider = checkCommandCodeProviderStatus(settings, environment).pipe(
        Effect.flatMap((snapshot) =>
          settings.enabled && snapshot.installed
            ? (settings.readAccountCredits
                ? readCommandCodeUsageLimits(environment)
                : DateTime.now.pipe(
                    Effect.map((now) => commandCodeUsagePointer(DateTime.formatIso(now))),
                  )
              ).pipe(Effect.map((usageLimits) => ({ ...snapshot, usageLimits })))
            : Effect.succeed(snapshot),
        ),
        Effect.map(stampIdentity),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.provideService(HttpClient.HttpClient, httpClient),
      );
      const snapshot = yield* makeManagedServerProvider({
        ...source,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        resolveMaintenance,
        initialSnapshot: (current) =>
          buildInitialCommandCodeSnapshot(current.provider).pipe(Effect.map(stampIdentity)),
        checkProvider,
      });
      return {
        ...input,
        driverKind: driver,
        continuationIdentity,
        orchestrationAdapter,
        snapshot,
        textGeneration,
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: COMMAND_CODE_DRIVER,
            instanceId: input.instanceId,
            detail: "Could not create Command Code v2 provider.",
            cause,
          }),
      ),
    ),
};
