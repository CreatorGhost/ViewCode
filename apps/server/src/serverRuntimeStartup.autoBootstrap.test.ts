import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerLifecycleStreamEvent,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { HttpServer } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import * as EnvironmentAuth from "./auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "./auth/ServerSecretStore.ts";
import * as CheckpointStore from "./checkpointing/CheckpointStore.ts";
import * as ServiceLauncherClient from "./cloud/serviceLauncherClient.ts";
import * as ServerConfig from "./config.ts";
import * as ServerEnvironment from "./environment/ServerEnvironment.ts";
import * as GitWorkflow from "./git/GitWorkflowService.ts";
import * as Keybindings from "./keybindings.ts";
import * as McpSessionRegistryTestkit from "./mcp/McpSessionRegistry.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./orchestration-v2/CommandReceiptStore.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as RuntimeLayer from "./orchestration-v2/runtimeLayer.ts";
import * as ThreadCommandExecutor from "./orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunch from "./orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "./orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as ExternalLauncher from "./process/externalLauncher.ts";
import * as ManagedProjectFolders from "./project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "./project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "./project/ProjectEnrichmentService.ts";
import * as ProjectService from "./project/ProjectService.ts";
import * as ProjectSetupScriptRunner from "./project/ProjectSetupScriptRunner.ts";
import * as WorktreeSetupTracker from "./project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "./provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./provider/ProviderRegistry.ts";
import * as AgentAwarenessRelay from "./relay/AgentAwarenessRelay.ts";
import { ServerActivation } from "./serverActivation.ts";
import * as ServerLifecycleEvents from "./serverLifecycleEvents.ts";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";
import * as ServerSettings from "./serverSettings.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as AnalyticsService from "./telemetry/AnalyticsService.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import * as TextGeneration from "./textGeneration/TextGeneration.ts";
import * as WorkspacePaths from "./workspace/WorkspacePaths.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

const codex = ProviderInstanceId.make("codex");
const custom = ProviderInstanceId.make("codex_selected");
const modelSelection = { instanceId: custom, model: "chosen-model" };
type Scenario =
  | "fresh"
  | "admin"
  | "project"
  | "enabled"
  | "existing"
  | "project-failure"
  | "settings-failure"
  | "launch-failure"
  | "interrupt";

const runStartup = (scenario: Scenario) =>
  Effect.scoped(
    Effect.gen(function* () {
      const activated = yield* Deferred.make<void>();
      const bootstrapEntered = yield* Deferred.make<void>();
      const bootstrapInterrupted = yield* Deferred.make<void>();
      let providerExecutions = 0;
      let launchCalls = 0;
      let failSettings = false;
      const database = SqlitePersistence.layerMemory;
      const baseConfig = ServerConfig.layerTest(process.cwd(), {
        prefix: "viewcode-welcome-startup-",
      });
      const config = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const value = yield* ServerConfig.ServerConfig;
          return {
            ...value,
            cwd: value.baseDir,
            autoBootstrapProjectFromCwd: true,
            noBrowser: true,
          };
        }),
      ).pipe(Layer.provide(baseConfig));
      const settings = ServerSettings.layer.pipe(Layer.provide(ServerSecretStore.layer));
      const fixtureInstance = (instanceId: ProviderInstanceId): ProviderInstance => ({
        instanceId,
        displayName: "Codex fixture",
        driverKind: ProviderDriverKind.make("codex"),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: instanceId,
        },
        enabled: true,
        orchestrationAdapter: {
          instanceId,
          driver: ProviderDriverKind.make("codex"),
          getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
          planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
          openSession: () =>
            Effect.sync(() => {
              providerExecutions++;
            }).pipe(Effect.andThen(Effect.die("welcome must not start a provider"))),
        } as ProviderInstance["orchestrationAdapter"],
        snapshot: {
          getSnapshot: Effect.die("welcome must not probe a provider"),
        } as unknown as ProviderInstance["snapshot"],
        textGeneration: {} as ProviderInstance["textGeneration"],
      });
      const instances = [fixtureInstance(codex), fixtureInstance(custom)];
      const external = Layer.mergeAll(
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => Effect.die("welcome must not resolve a source-control link"),
        }),
        Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
          getInstance: (id) => Effect.succeed(instances.find((entry) => entry.instanceId === id)),
          listInstances: Effect.succeed(instances),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            { instanceId: codex, enabled: true, disabledByAdmin: scenario === "admin" },
            { instanceId: custom, enabled: true },
          ] as never),
        }),
        Layer.mock(CheckpointStore.CheckpointStore)({}),
        Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
        Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
          peek: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
          getAvailable: () =>
            Effect.succeed({
              repositoryIdentity: null,
              faviconPath: null,
              repositoryIdentityResolved: false,
            }),
          invalidate: () => Effect.void,
        }),
        Layer.mock(WorkspacePaths.WorkspacePaths)({
          normalizeWorkspaceRoot: (root) => Effect.succeed(root),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
        Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
          namedProjectsRoot: "/unused-managed-projects",
          folderForThread: () => Effect.succeedNone,
        }),
        Layer.mock(TerminalManager.TerminalManager)({ close: () => Effect.void }),
        Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({
          runForThread: () => Effect.succeed({ status: "no-script" }),
        }),
        Layer.mock(TextGeneration.TextGeneration)({}),
        WorktreeSetupTracker.layer,
        IdAllocator.layer,
        McpProviderSessions.layer,
        McpSessionRegistryTestkit.layer,
      );
      const projects = RuntimeLayer.layerProjectService;
      const native = Layer.mergeAll(
        RuntimeLayer.layer.pipe(Layer.provide(projects)),
        projects,
        RuntimeLayer.layerEventSink,
        ProjectStore.layer,
        ProjectionStore.layer,
        ThreadCommandExecutor.layer,
        CommandReceiptStore.layer,
      ).pipe(Layer.provideMerge(external));
      const nativeWithLaunch = ThreadLaunch.layer.pipe(Layer.provideMerge(native));
      const dependencies = nativeWithLaunch.pipe(
        Layer.provideMerge(settings),
        Layer.provideMerge(database),
        Layer.provideMerge(config),
        Layer.provideMerge(NodeServices.layer),
      );
      const context = yield* Layer.build(dependencies);
      const configValue = Context.get(context, ServerConfig.ServerConfig);
      const settingsService = Context.get(context, ServerSettings.ServerSettingsService);
      const projectService = Context.get(context, ProjectService.ProjectService);
      const threads = Context.get(context, ThreadManagement.ThreadManagementService);
      const launcher = Context.get(context, ThreadLaunch.ThreadLaunchService);
      yield* settingsService.start;
      const freshSettings = yield* settingsService.getSettings;
      assert.isTrue(
        Object.values(freshSettings.providerInstances).every((entry) => entry.enabled === false),
      );
      if (scenario !== "fresh" && scenario !== "project-failure") {
        yield* settingsService.updateSettings({
          providerInstances: {
            [codex]: { driver: ProviderDriverKind.make("codex"), enabled: true },
            [custom]: { driver: ProviderDriverKind.make("codex"), enabled: true },
          },
        });
      }
      let existingThreadId: string | undefined;
      if (["project", "enabled", "existing"].includes(scenario)) {
        const { project } = yield* projectService.bootstrap({
          commandId: CommandId.make("seed-project"),
          projectId: ProjectId.make("existing-welcome-project"),
          title: "Existing project",
          workspaceRoot: configValue.cwd,
        });
        yield* projectService.update({
          commandId: CommandId.make("seed-default"),
          projectId: project.id,
          defaultModelSelection: modelSelection,
        });
        if (scenario === "project") {
          yield* settingsService.updateSettings({
            projectSettingsOverrides: {
              [project.id]: {
                defaultModelSelection: modelSelection,
                providerInstances: { [custom]: { enabled: false } },
              },
            },
          });
        }
        if (scenario === "existing") {
          existingThreadId = (yield* launcher.launch({
            commandId: CommandId.make("seed-thread"),
            projectId: project.id,
            title: "Existing",
            modelSelection,
            interactionMode: "default",
            runtimeMode: "approval-required",
            workspaceStrategy: { type: "root" },
            createdBy: "user",
            creationSource: "server",
          })).threadId;
          yield* settingsService.updateSettings({
            providerInstances: {
              [custom]: { driver: ProviderDriverKind.make("codex"), enabled: false },
            },
          });
        }
      }
      const wrappedSettings = {
        ...settingsService,
        getSettings: Effect.suspend(() =>
          failSettings ? Effect.die("settings read failed") : settingsService.getSettings,
        ),
      };
      const wrappedProjects = {
        ...projectService,
        bootstrap: (input: Parameters<typeof projectService.bootstrap>[0]) =>
          scenario === "project-failure"
            ? Effect.fail(
                new ProjectService.ProjectOperationError({
                  operation: "dispatch-project-command",
                  cause: new Error("cannot create project"),
                }),
              )
            : scenario === "interrupt"
              ? Deferred.succeed(bootstrapEntered, undefined).pipe(
                  Effect.andThen(Effect.never),
                  Effect.onInterrupt(() => Deferred.succeed(bootstrapInterrupted, undefined)),
                )
              : projectService.bootstrap(input).pipe(
                  Effect.tap(() =>
                    Effect.sync(() => {
                      if (scenario === "settings-failure") failSettings = true;
                    }),
                  ),
                ),
      };
      const wrappedLaunch = {
        ...launcher,
        launch: (input: Parameters<typeof launcher.launch>[0]) =>
          Effect.sync(() => {
            launchCalls++;
          }).pipe(
            Effect.andThen(
              scenario === "launch-failure"
                ? Effect.fail(
                    new ThreadLaunch.ThreadLaunchError({
                      operation: "create-thread",
                      commandId: input.commandId,
                      projectId: input.projectId,
                      cause: new Error("launch failed"),
                    }),
                  )
                : launcher.launch(input),
            ),
          ),
      };
      const events: ServerLifecycleStreamEvent[] = [];
      const startupDependencies = Layer.mergeAll(
        Layer.succeedContext(context),
        Layer.succeed(ProjectService.ProjectService, wrappedProjects),
        Layer.succeed(ServerSettings.ServerSettingsService, wrappedSettings),
        Layer.succeed(ThreadLaunch.ThreadLaunchService, wrappedLaunch),
        Layer.mock(Keybindings.Keybindings)({ start: Effect.void }),
        Layer.mock(AgentAwarenessRelay.AgentAwarenessRelay)({ start: () => Effect.void }),
        Layer.mock(ServerLifecycleEvents.ServerLifecycleEvents)({
          publish: (event) =>
            Effect.sync(() => {
              const stored = { ...event, sequence: events.length + 1 };
              events.push(stored);
              return stored;
            }),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId: EnvironmentId.make("welcome-environment"),
            label: "Welcome test",
            platform: { os: "darwin", arch: "arm64" },
            serverVersion: "test",
            capabilities: { repositoryIdentity: true },
          }),
        }),
        Layer.mock(ServiceLauncherClient.ServiceLauncherClient)({
          managed: false,
          prepareTrial: Effect.succeed(undefined),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({
          issueStartupPairingUrl: () => Effect.succeed("http://localhost/test-pairing"),
        }),
        Layer.mock(ExternalLauncher.ExternalLauncher)({}),
        Layer.mock(AnalyticsService.AnalyticsService)({ record: () => Effect.void }),
        Layer.mock(GitVcsDriver.GitVcsDriver)({}),
        Layer.mock(HttpServer.HttpServer)({
          address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
        }),
      );
      const startupLayer = ServerRuntimeStartup.layerWithOptions({
        activate: Deferred.succeed(activated, undefined).pipe(Effect.asVoid),
      }).pipe(Layer.provide(startupDependencies));
      yield* Effect.gen(function* () {
        const startup = yield* ServerRuntimeStartup.ServerRuntimeStartup;
        yield* startup.markHttpListening;
        if (scenario === "interrupt") {
          yield* Deferred.await(bootstrapEntered);
          assert.isFalse(yield* Deferred.isDone(activated));
          return;
        }
        yield* startup.awaitCommandReady;
        assert.equal(yield* startup.enqueueCommand(Effect.succeed("ready")), "ready");
      }).pipe(
        Effect.provide(startupLayer),
        Effect.provideService(ServerActivation, Deferred.await(activated)),
      );
      if (scenario === "interrupt") {
        assert.isTrue(yield* Deferred.isDone(bootstrapInterrupted));
        assert.isFalse(yield* Deferred.isDone(activated));
      }
      failSettings = false;
      const snapshot = yield* projectService.snapshot;
      const shell = yield* threads.getShellSnapshot();
      const welcome = events.find((event) => event.type === "welcome");
      if (scenario !== "interrupt") assert.isTrue(events.some((event) => event.type === "ready"));
      assert.equal(providerExecutions, 0);
      return { snapshot, shell, welcome, launchCalls, existingThreadId };
    }),
  );

it.effect(
  "fresh web home reaches actual command readiness with all providers off and only a project",
  () =>
    runStartup("fresh").pipe(
      Effect.tap(({ snapshot, shell, welcome, launchCalls }) =>
        Effect.sync(() => {
          assert.lengthOf(snapshot.projects, 1);
          assert.lengthOf(shell.threads, 0);
          assert.equal(launchCalls, 0);
          assert.equal(welcome?.type, "welcome");
          if (welcome?.type === "welcome") {
            assert.equal(welcome.payload.bootstrapProjectId, snapshot.projects[0]?.id);
            assert.isUndefined(welcome.payload.bootstrapThreadId);
          }
        }),
      ),
    ),
);
it.effect.each(["admin", "project"] as const)(
  "keeps the project without a thread when the selected provider is %s-blocked",
  (scenario) =>
    runStartup(scenario).pipe(
      Effect.tap(({ snapshot, shell, launchCalls }) =>
        Effect.sync(() => {
          assert.lengthOf(snapshot.projects, 1);
          assert.lengthOf(shell.threads, 0);
          assert.equal(launchCalls, 0);
        }),
      ),
    ),
);
it.effect("launches the enabled project model without falling back to canonical Codex", () =>
  runStartup("enabled").pipe(
    Effect.tap(({ shell, launchCalls }) =>
      Effect.sync(() => {
        assert.equal(launchCalls, 1);
        assert.lengthOf(shell.threads, 1);
        assert.deepEqual(shell.threads[0]?.modelSelection, modelSelection);
      }),
    ),
  ),
);
it.effect("reuses an existing thread even after its provider is disabled", () =>
  runStartup("existing").pipe(
    Effect.tap(({ shell, welcome, launchCalls, existingThreadId }) =>
      Effect.sync(() => {
        assert.equal(launchCalls, 0);
        assert.lengthOf(shell.threads, 1);
        if (welcome?.type === "welcome")
          assert.equal(welcome.payload.bootstrapThreadId, existingThreadId);
      }),
    ),
  ),
);
it.effect.each(["project-failure", "settings-failure", "launch-failure"] as const)(
  "optional %s cannot prevent actual startup readiness",
  (scenario) =>
    runStartup(scenario).pipe(
      Effect.tap(({ snapshot, shell, welcome }) =>
        Effect.sync(() => {
          assert.lengthOf(snapshot.projects, scenario === "project-failure" ? 0 : 1);
          assert.lengthOf(shell.threads, 0);
          if (welcome?.type === "welcome")
            assert.equal(welcome.payload.bootstrapProjectId, snapshot.projects[0]?.id);
        }),
      ),
    ),
);
it.effect("shutdown interrupts optional welcome work instead of continuing activation", () =>
  runStartup("interrupt").pipe(Effect.asVoid),
);
