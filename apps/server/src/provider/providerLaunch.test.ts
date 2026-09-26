// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettingsPatch,
  type ServerSettings,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { createModelSelection } from "@t3tools/shared/model";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerConfig from "../config.ts";
import * as ServerSettingsModule from "../serverSettings.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import { AntigravityInstallation } from "./AntigravityInstallation.ts";
import { ProviderInstanceRegistryHydrationLive } from "./Layers/ProviderInstanceRegistryHydration.ts";
import * as ProviderEventLoggers from "./Layers/ProviderEventLoggers.ts";
import { ProviderRegistryLive } from "./Layers/ProviderRegistry.ts";
import * as ResetCreditCoordinator from "./Layers/resetCreditCoordinator.ts";
import * as ModelManifest from "./ModelManifest.ts";
import * as OpenCodeRuntime from "./opencodeRuntime.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { detectProviders } from "./providerLaunch.ts";
import { applyProviderSelectionRules, makeChooseProvidersPatch } from "./providerSelection.ts";
import * as ProviderInstanceRegistry from "./Services/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "./Services/ProviderRegistry.ts";

// The stubs are `#!/bin/sh` scripts; they are never executed (the spawner is a
// recording fake), but must exist and be executable for the lookup.
const windowsHost = HostProcessPlatform.defaultValue() === "win32";
const TEST_EPOCH = DateTime.makeUnsafe("1970-01-01T00:00:00.000Z");
const encodeSettingsPatch = Schema.encodeEffect(Schema.fromJsonString(ServerSettingsPatch));

const makeStubDir = (names: ReadonlyArray<string>) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-provider-launch-"));
  for (const name of names) {
    const file = NodePath.join(dir, name);
    NodeFS.writeFileSync(file, "#!/bin/sh\nexit 1\n");
    NodeFS.chmodSync(file, 0o755);
  }
  return dir;
};

/** Settings where every CLI provider points at an existing stub executable. */
const stubbedSettings = (dir: string, selection: ServerSettings["providerSelection"]) =>
  ({
    ...DEFAULT_SERVER_SETTINGS,
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, binaryPath: `${dir}/codex` },
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        binaryPath: `${dir}/claude`,
      },
      cursor: { ...DEFAULT_SERVER_SETTINGS.providers.cursor, binaryPath: `${dir}/cursor-agent` },
      grok: { ...DEFAULT_SERVER_SETTINGS.providers.grok, binaryPath: `${dir}/grok` },
      opencode: { ...DEFAULT_SERVER_SETTINGS.providers.opencode, binaryPath: `${dir}/opencode` },
      commandCode: { ...DEFAULT_SERVER_SETTINGS.providers.commandCode, binaryPath: `${dir}/cmd` },
    },
    ...(selection ? { providerSelection: selection } : {}),
  }) satisfies ServerSettings;

/** In-memory settings service applying the same selection rules as the real one. */
const makeSettingsService = (initial: ServerSettings) =>
  Effect.gen(function* () {
    const ref = yield* Ref.make(initial);
    const changes = yield* PubSub.unbounded<ServerSettings>();
    return {
      start: Effect.void,
      ready: Effect.void,
      getSettings: Ref.get(ref),
      updateSettings: (patch) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(ref);
          const next = applyProviderSelectionRules(
            current,
            patch,
            applyServerSettingsPatch(current, patch),
          );
          yield* Ref.set(ref, next);
          yield* PubSub.publish(changes, next);
          return next;
        }),
      get streamChanges() {
        return Stream.fromPubSub(changes);
      },
      get subscribeChanges() {
        return PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription));
      },
    } satisfies ServerSettingsModule.ServerSettingsService["Service"];
  });

/** Records every spawn and fails it like a CLI that exits 1, without executing anything. */
const makeRecordingSpawner = (onSpawn: (command: string) => Effect.Effect<void>) => {
  const spawned: Array<string> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      const name = command._tag === "StandardCommand" ? command.command : "<piped>";
      spawned.push(name);
      yield* onSpawn(name);
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(1)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        unref: Effect.succeed(Effect.void),
        stdin: Sink.drain,
        stdout: Stream.empty,
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  return { spawner, spawned };
};

const TestHttpClientLive = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
  ),
);

const BackgroundPolicyAlwaysRunLayer = Layer.mock(BackgroundPolicy.BackgroundPolicy)({
  reportClientActivity: () => Effect.void,
  removeRpcClient: () => Effect.void,
  reportHostPowerState: () => Effect.void,
  snapshot: Effect.succeed({
    hostPower: {
      source: "unknown",
      idle: "unknown",
      idleSeconds: null,
      locked: "unknown",
      suspended: false,
      onBattery: "unknown",
      lowPowerMode: "unknown",
      thermalState: "unknown",
      stale: true,
      updatedAt: TEST_EPOCH,
    },
    leases: [],
    activeForegroundLeaseCount: 0,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: TEST_EPOCH,
  }),
  streamChanges: Stream.empty,
  hasDemand: () => Effect.succeed(true),
  shouldRunScopeWork: () => Effect.succeed(true),
  shouldRunOpportunisticWork: Effect.succeed(true),
});

const buildRegistry = (
  settings: ServerSettingsModule.ServerSettingsService["Service"],
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  ProviderRegistryLive.pipe(
    Layer.provideMerge(ProviderInstanceRegistryHydrationLive),
    Layer.provideMerge(AntigravityInstallation.layer),
    Layer.provideMerge(Layer.succeed(ServerSettingsModule.ServerSettingsService, settings)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-launch-" })),
    Layer.provideMerge(TestHttpClientLive),
    Layer.provideMerge(
      Layer.succeed(
        ProviderEventLoggers.ProviderEventLoggers,
        ProviderEventLoggers.NoOpProviderEventLoggers,
      ),
    ),
    Layer.provideMerge(ModelManifest.layerTest),
    Layer.provideMerge(ResetCreditCoordinator.layerTest),
    Layer.provideMerge(OpenCodeRuntime.OpenCodeRuntimeLive),
    Layer.updateService(ChildProcessSpawner.ChildProcessSpawner, () => spawner),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(BackgroundPolicyAlwaysRunLayer),
  );

describe("first-run provider selection", () => {
  it.effect.skipIf(windowsHost)(
    "launches nothing while pending, then probes only the chosen provider",
    () =>
      Effect.gen(function* () {
        const dir = makeStubDir(["codex", "claude", "cursor-agent", "grok", "opencode", "cmd"]);
        const claudeStub = `${dir}/claude`;
        const claudeSpawned = yield* Deferred.make<void>();
        const { spawner, spawned } = makeRecordingSpawner((command) =>
          command === claudeStub ? Deferred.succeed(claudeSpawned, undefined) : Effect.void,
        );
        const settings = yield* makeSettingsService(stubbedSettings(dir, "pending"));
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.build(buildRegistry(settings, spawner)).pipe(
          Scope.provide(scope),
        );

        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          // Boot probe, manual refresh-all, interval and workspace refresh.
          const providers = yield* registry.refresh();
          yield* TestClock.adjust("2 hours");
          yield* registry.refresh();
          yield* registry.refreshWorkspaceSnapshot({
            instanceId: ProviderInstanceId.make("codex"),
            cwd: process.cwd(),
          });
          assert.deepStrictEqual(spawned, []);
          // Every provider is still listed, switched off, for the picker.
          assert.isAtLeast(providers.length, 6);
          assert.isTrue(providers.every((provider) => !provider.enabled));

          yield* settings.updateSettings(
            makeChooseProvidersPatch([ProviderDriverKind.make("claudeAgent")]),
          );
          yield* Deferred.await(claudeSpawned);
          yield* registry.refresh();
          assert.deepStrictEqual([...new Set(spawned)], [claudeStub]);
        }).pipe(Effect.provide(services));
      }),
  );

  it.effect.skipIf(windowsHost)(
    "does not probe default-seeded settings until an explicit choice",
    () =>
      Effect.gen(function* () {
        const dir = makeStubDir(["codex", "claude", "cursor-agent", "grok", "opencode", "cmd"]);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => NodeFS.rmSync(dir, { recursive: true })),
        );
        const config = yield* ServerConfig.ServerConfig;
        const fs = yield* FileSystem.FileSystem;
        // Older app writes include enabled defaults but have no choice marker.
        yield* fs.writeFileString(
          config.settingsPath,
          yield* encodeSettingsPatch({
            providers: stubbedSettings(dir, undefined).providers,
          }),
        );
        const settings = yield* ServerSettingsModule.ServerSettingsService;
        const claudeSpawned = yield* Deferred.make<void>();
        const { spawner, spawned } = makeRecordingSpawner((command) =>
          command === `${dir}/claude` ? Deferred.succeed(claudeSpawned, undefined) : Effect.void,
        );
        const scope = yield* Scope.make();
        yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
        const services = yield* Layer.build(buildRegistry(settings, spawner)).pipe(
          Scope.provide(scope),
        );
        yield* Effect.gen(function* () {
          const registry = yield* ProviderRegistry.ProviderRegistry;
          yield* registry.refresh();
          yield* TestClock.adjust("2 hours");
          yield* registry.refresh();
          assert.deepStrictEqual(spawned, []);
          assert.strictEqual((yield* settings.getSettings).providerSelection, "pending");
          yield* settings.updateSettings(
            makeChooseProvidersPatch([ProviderDriverKind.make("claudeAgent")]),
          );
          yield* Deferred.await(claudeSpawned);
          yield* registry.refresh();
          assert.deepStrictEqual([...new Set(spawned)], [`${dir}/claude`]);
        }).pipe(Effect.provide(services));
      }).pipe(
        Effect.provide(
          ServerSettingsModule.layer.pipe(
            Layer.provide(ServerSecretStore.layer),
            Layer.provideMerge(Layer.fresh(SqlitePersistenceMemory)),
            Layer.provideMerge(
              Layer.fresh(
                ServerConfig.layerTest(process.cwd(), { prefix: "t3-provider-launch-settings-" }),
              ),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect.skipIf(windowsHost)("keeps today's behaviour for an environment already chosen", () =>
    Effect.gen(function* () {
      const dir = makeStubDir(["codex", "claude", "cursor-agent", "grok", "opencode", "cmd"]);
      const { spawner, spawned } = makeRecordingSpawner(() => Effect.void);
      const settings = yield* makeSettingsService(stubbedSettings(dir, "chosen"));
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const services = yield* Layer.build(buildRegistry(settings, spawner)).pipe(
        Scope.provide(scope),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* registry.refresh();
        // Codex and Claude are on by default and get probed as before.
        assert.includeMembers([...new Set(spawned)], [`${dir}/codex`, `${dir}/claude`]);
      }).pipe(Effect.provide(services));
    }),
  );
});

describe("turning a provider off", () => {
  it.effect.skipIf(windowsHost)("stops its in-flight probe and never relaunches it", () =>
    Effect.gen(function* () {
      const dir = makeStubDir(["claude"]);
      const claudeStub = `${dir}/claude`;
      const probeStarted = yield* Deferred.make<void>();
      const probeKilled = yield* Deferred.make<void>();
      const spawned: Array<string> = [];
      // Claude's version probe hangs until its scope closes.
      const spawner = ChildProcessSpawner.make((command) =>
        Effect.gen(function* () {
          const name = command._tag === "StandardCommand" ? command.command : "<piped>";
          spawned.push(name);
          yield* Effect.addFinalizer(() => Deferred.succeed(probeKilled, undefined));
          yield* Deferred.succeed(probeStarted, undefined);
          return ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(1),
            exitCode: Effect.never,
            isRunning: Effect.succeed(true),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.never,
            stderr: Stream.never,
            all: Stream.never,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          });
        }),
      );
      const initial = {
        ...stubbedSettings(dir, "chosen"),
        providers: {
          ...stubbedSettings(dir, "chosen").providers,
          codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false },
        },
      } satisfies ServerSettings;
      const settings = yield* makeSettingsService(initial);
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const services = yield* Layer.build(buildRegistry(settings, spawner)).pipe(
        Scope.provide(scope),
      );
      yield* Effect.gen(function* () {
        const registry = yield* ProviderRegistry.ProviderRegistry;
        yield* Deferred.await(probeStarted);
        const claudeOff = yield* registry.streamChanges.pipe(
          Stream.filter((providers) =>
            providers.some(
              (provider) => provider.instanceId === "claudeAgent" && !provider.enabled,
            ),
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.forkScoped,
        );
        yield* settings.updateSettings({ providers: { claudeAgent: { enabled: false } } });
        // The rebuild closes the old instance, interrupting the probe.
        yield* Deferred.await(probeKilled);
        yield* Fiber.join(claudeOff);
        assert.deepStrictEqual(spawned, [claudeStub]);
      }).pipe(Effect.scoped, Effect.provide(services));
    }),
  );
});

describe("detectProviders", () => {
  it.effect.skipIf(windowsHost)("reports found and missing executables without spawning", () =>
    Effect.gen(function* () {
      // No ChildProcessSpawner is provided at all: detection cannot spawn.
      const dir = makeStubDir(["claude", "cursor-agent"]);
      const detected = yield* detectProviders(stubbedSettings(dir, "pending"));
      const byDriver = new Map(detected.map((entry) => [entry.driver, entry]));
      assert.deepStrictEqual(byDriver.get(ProviderDriverKind.make("claudeAgent")), {
        driver: ProviderDriverKind.make("claudeAgent"),
        installed: true,
        path: `${dir}/claude`,
      });
      assert.strictEqual(byDriver.get(ProviderDriverKind.make("cursor"))?.installed, true);
      assert.deepStrictEqual(byDriver.get(ProviderDriverKind.make("codex")), {
        driver: ProviderDriverKind.make("codex"),
        installed: false,
        path: null,
      });
      assert.strictEqual(detected.length, Object.keys(DEFAULT_SERVER_SETTINGS.providers).length);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("text generation launch guard", () => {
  it.effect("does not run text generation on a disabled provider", () =>
    Effect.gen(function* () {
      const instanceId = ProviderInstanceId.make("codex");
      let calls = 0;
      const instance = {
        instanceId,
        driverKind: ProviderDriverKind.make("codex"),
        continuationIdentity: {
          driverKind: ProviderDriverKind.make("codex"),
          continuationKey: "codex:test",
        },
        displayName: undefined,
        enabled: false,
        snapshot: {} as ProviderInstance["snapshot"],
        adapter: {} as ProviderInstance["adapter"],
        textGeneration: TextGeneration.TextGeneration.of({
          generateCommitMessage: () => Effect.die("unused"),
          generatePrContent: () => Effect.die("unused"),
          generateBranchName: () => Effect.die("unused"),
          generateThreadTitle: () => {
            calls += 1;
            return Effect.succeed({ title: "launched" });
          },
        }),
      } satisfies ProviderInstance;
      const generation = yield* TextGeneration.make.pipe(
        Effect.provideService(ProviderInstanceRegistry.ProviderInstanceRegistry, {
          getInstance: () => Effect.succeed(instance),
          listInstances: Effect.succeed([instance]),
          listUnavailable: Effect.succeed([]),
          streamChanges: Stream.empty,
          subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), PubSub.subscribe),
        }),
        Effect.provide(
          Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
            resolveLink: () => Effect.die("unused"),
          }),
        ),
      );
      const error = yield* Effect.flip(
        generation.generateThreadTitle({
          cwd: process.cwd(),
          message: "hello",
          modelSelection: createModelSelection(instanceId, "gpt-5"),
        }),
      );
      assert.include(error.detail, "disabled");
      assert.strictEqual(calls, 0);
    }),
  );
});
