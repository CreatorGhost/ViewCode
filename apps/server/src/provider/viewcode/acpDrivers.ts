import { withAgentDeviceEnvironment } from "@t3tools/provider-core/server/mcpSession";
import {
  normalizeDevinSessionUpdate,
  normalizeDevinToolCall,
  extractDevinSubagentUpdate,
} from "@t3tools/provider-acp-registry/server";
import {
  DevinSettings,
  DroidSettings,
  ProviderDriverKind,
  type OrchestrationV2ProviderCapabilities,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { resolveSelfInvocation } from "@t3tools/shared/nodeRuntime";
import {
  AcpProviderCapabilitiesV2,
  makeAcpAdapterV2,
  type AcpAdapterV2Flavor,
} from "@t3tools/provider-acp/server/adapter";
import { makeAcpNativeLoggerFactory } from "@t3tools/provider-acp/server/nativeLogging";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
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
import { configureDroidSession, makeDroidAcpRuntime } from "./droidAcpSupport.ts";
import { configureDevinSession, makeDevinAcpRuntime, devinModeId } from "./devinAcpSupport.ts";
import { buildInitialDroidProviderSnapshot, checkDroidProviderStatus } from "./droidStatus.ts";
import { buildInitialDevinProviderSnapshot, checkDevinProviderStatus } from "./devinStatus.ts";
import { makeAcpTextGeneration } from "./acpTextGeneration.ts";

export type ViewCodeAcpDriverEnv =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | FileSystem.FileSystem
  | Path.Path
  | ProviderHost.ProviderHost
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | ProviderEventLoggers.ProviderEventLoggers;

export const ViewCodeAcpCapabilities = {
  ...AcpProviderCapabilitiesV2,
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  tools: { ...AcpProviderCapabilitiesV2.tools, supportsMcpTools: true },
} satisfies OrchestrationV2ProviderCapabilities;

const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const decodeDevinSettings = Schema.decodeSync(DevinSettings);

export const DroidDriver: ProviderDriver<DroidSettings, ViewCodeAcpDriverEnv> = {
  driverKind: ProviderDriverKind.make("droid"),
  metadata: { displayName: "Droid", supportsMultipleInstances: true },
  configSchema: DroidSettings,
  defaultConfig: () => decodeDroidSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const driver = DroidDriver.driverKind;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
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
      const selfInvocation = yield* resolveSelfInvocation();
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const nativeLogger = yield* makeAcpNativeLoggerFactory();
      const flavor: AcpAdapterV2Flavor = {
        driver,
        capabilities: ViewCodeAcpCapabilities,
        preferResumeSession: true,
        makeRuntime: (runtimeInput) =>
          makeDroidAcpRuntime({
            ...runtimeInput,
            settings,
            environment: withAgentDeviceEnvironment(
              { ...environment, ...runtimeInput.processEnvironment },
              runtimeInput.mcpSession,
            ),
            childProcessSpawner: spawner,
          }),
        applyModelSelection: ({ runtime, modelSelection }) =>
          configureDroidSession({
            runtime,
            runtimeMode: "approval-required",
            interactionMode: undefined,
            model: modelSelection.model,
            options: modelSelection.options,
          }).pipe(Effect.as(modelSelection.model)),
        configureRuntimePolicy: ({ runtime, runtimePolicy }) =>
          configureDroidSession({
            runtime,
            ...runtimePolicy,
            model: undefined,
            options: undefined,
          }),
      };
      const orchestrationAdapter = yield* makeAcpAdapterV2({
        instanceId: input.instanceId,
        flavor,
        selfInvocation,
        nativeLogging: (threadId) =>
          nativeLogger({ nativeEventLogger: loggers.native, provider: driver, threadId }),
      });
      const textGeneration = yield* makeAcpTextGeneration({
        label: "Droid",
        makeRuntime: (cwd) =>
          makeDroidAcpRuntime({
            settings,
            environment,
            childProcessSpawner: spawner,
            cwd,
            clientInfo: { name: "viewcode-text", version: "0.1.0" },
          }),
        configure: (runtime, modelSelection) =>
          configureDroidSession({
            runtime,
            runtimeMode: "approval-required",
            interactionMode: undefined,
            model: modelSelection.model,
            options: modelSelection.options,
          }),
      });
      const source = yield* makeProviderSnapshotSettingsSource(settings);
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: driver,
        packageName: "droid",
      });
      const snapshot = yield* makeManagedServerProvider({
        ...source,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        resolveMaintenance: () => Effect.succeed(maintenance),
        initialSnapshot: (current) =>
          buildInitialDroidProviderSnapshot(current.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkDroidProviderStatus(settings, environment).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
        ),
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
            driver: DroidDriver.driverKind,
            instanceId: input.instanceId,
            detail: "Could not create Droid v2 provider.",
            cause,
          }),
      ),
    ),
};

export const DevinDriver: ProviderDriver<DevinSettings, ViewCodeAcpDriverEnv> = {
  driverKind: ProviderDriverKind.make("devin"),
  metadata: { displayName: "Devin", supportsMultipleInstances: true },
  configSchema: DevinSettings,
  defaultConfig: () => decodeDevinSettings({}),
  create: (input) =>
    Effect.gen(function* () {
      const driver = DevinDriver.driverKind;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
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
      const selfInvocation = yield* resolveSelfInvocation();
      const loggers = yield* ProviderEventLoggers.ProviderEventLoggers;
      const nativeLogger = yield* makeAcpNativeLoggerFactory();
      const flavor: AcpAdapterV2Flavor = {
        driver,
        capabilities: {
          ...ViewCodeAcpCapabilities,
          subagents: {
            ...ViewCodeAcpCapabilities.subagents,
            supportsSubagents: true,
            exposesSubagentThreadIds: true,
            emitsSubagentLifecycle: true,
          },
        },
        clientCapabilitiesMeta: {
          "cognition.ai/subagentSupport": true,
          "cognition.ai/messageGrouping": true,
        },
        normalizeSessionUpdate: normalizeDevinSessionUpdate,
        normalizeToolCall: normalizeDevinToolCall,
        extractSubagentUpdate: extractDevinSubagentUpdate,
        makeRuntime: (runtimeInput) =>
          makeDevinAcpRuntime({
            ...runtimeInput,
            settings,
            environment: withAgentDeviceEnvironment(
              { ...environment, ...runtimeInput.processEnvironment },
              runtimeInput.mcpSession,
            ),
            childProcessSpawner: spawner,
          }),
        applyModelSelection: ({ runtime, modelSelection }) =>
          configureDevinSession({
            runtime,
            runtimeMode: "approval-required",
            interactionMode: undefined,
            model: modelSelection.model,
          }).pipe(Effect.as(modelSelection.model)),
        configureRuntimePolicy: ({ runtime, runtimePolicy }) =>
          runtime.setMode(devinModeId(runtimePolicy)).pipe(Effect.asVoid),
      };
      const orchestrationAdapter = yield* makeAcpAdapterV2({
        instanceId: input.instanceId,
        flavor,
        selfInvocation,
        clientTerminals: { environment, shellCommands: true },
        nativeLogging: (threadId) =>
          nativeLogger({ nativeEventLogger: loggers.native, provider: driver, threadId }),
      });
      const textGeneration = yield* makeAcpTextGeneration({
        label: "Devin",
        makeRuntime: (cwd) =>
          makeDevinAcpRuntime({
            settings,
            environment,
            childProcessSpawner: spawner,
            cwd,
            clientInfo: { name: "viewcode-text", version: "0.1.0" },
          }),
        configure: (runtime, selection) =>
          configureDevinSession({
            runtime,
            runtimeMode: "approval-required",
            interactionMode: undefined,
            model: selection.model,
          }).pipe(Effect.andThen(runtime.setMode("ask"))),
      });
      const source = yield* makeProviderSnapshotSettingsSource(settings);
      const maintenance = makeManualOnlyProviderMaintenanceCapabilities({
        provider: driver,
        packageName: null,
      });
      const snapshot = yield* makeManagedServerProvider({
        ...source,
        haveSettingsChanged: haveProviderSnapshotSettingsChanged,
        resolveMaintenance: () => Effect.succeed(maintenance),
        initialSnapshot: (current) =>
          buildInitialDevinProviderSnapshot(current.provider).pipe(Effect.map(stampIdentity)),
        checkProvider: checkDevinProviderStatus(settings, environment).pipe(
          Effect.map(stampIdentity),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        ),
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
            driver: DevinDriver.driverKind,
            instanceId: input.instanceId,
            detail: "Could not create Devin v2 provider.",
            cause,
          }),
      ),
    ),
};
