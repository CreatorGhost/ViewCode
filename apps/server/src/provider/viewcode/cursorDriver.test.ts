// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import * as CursorKeychain from "@t3tools/provider-cursor/server/CursorKeychain";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import type { ProviderDriver, ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as BackgroundPolicy from "../../background/BackgroundPolicy.ts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ModelManifest from "../ModelManifest.ts";
import * as ProviderHostLive from "../ProviderHostLive.ts";
import { makeCursorAgentAuth } from "./cursorAgentAuth.ts";
import { parseCursorAgentAbout } from "./cursorAgentStatus.ts";
import { makeViewCodeCursorDriver } from "./cursorDriver.ts";
import { effectiveCursorRuntime, resolveCursorRuntime } from "./cursorRuntime.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const mockAgentPath = NodePath.resolve(import.meta.dirname, "../../../scripts/acp-mock-agent.ts");
const ABOUT_JSON = JSON.stringify({
  cliVersion: "2026.10.01-test",
  userEmail: "dev@example.test",
  subscriptionTier: "pro",
});

/** A spawner that refuses to run anything: the runtime choice must never start a process. */
const refusingSpawner = ChildProcessSpawner.make(() =>
  Effect.die("Resolving the Cursor runtime must not spawn a process."),
);

const settings = (patch: Partial<CursorSettings> = {}): CursorSettings => ({
  enabled: true,
  customModels: [],
  ...patch,
});

describe("Cursor runtime default", () => {
  it("prefers cursor-agent on macOS, the SDK elsewhere, and cursor-agent where no SDK ships", () => {
    const resolve = (
      platform: NodeJS.Platform,
      found: boolean,
      sdkSupported = true,
      configured?: "cursor-agent" | "sdk",
    ) => resolveCursorRuntime({ configured, platform, sdkSupported, cursorAgentFound: found });
    assert.equal(resolve("darwin", true), "cursor-agent");
    assert.equal(resolve("darwin", false), "sdk");
    assert.equal(resolve("darwin", false, false), "cursor-agent");
    assert.equal(resolve("linux", true), "sdk");
    assert.equal(resolve("win32", false, false), "cursor-agent");
    assert.equal(resolve("darwin", true, true, "sdk"), "sdk");
    assert.equal(resolve("linux", false, true, "cursor-agent"), "cursor-agent");
  });

  it.effect("finds cursor-agent on macOS by a PATH lookup and never runs it", () =>
    Effect.gen(function* () {
      const looked: Array<string> = [];
      const runtime = yield* effectiveCursorRuntime(settings(), { PATH: "/opt/cursor/bin" }).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HostProcess.Architecture, "arm64"),
        Effect.provideService(SpawnExecutableResolution, (command) => {
          looked.push(command);
          return `/opt/cursor/bin/${command}`;
        }),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusingSpawner),
      );
      assert.equal(runtime, "cursor-agent");
      assert.deepEqual(looked, ["cursor-agent"]);
    }),
  );

  it.effect("does not look for the executable when the runtime is chosen or off macOS", () =>
    Effect.gen(function* () {
      const looked: Array<string> = [];
      const lookup = (command: string) => {
        looked.push(command);
        return `/usr/bin/${command}`;
      };
      const chosen = yield* effectiveCursorRuntime(settings({ runtime: "sdk" }), {}).pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(SpawnExecutableResolution, lookup),
      );
      const linux = yield* effectiveCursorRuntime(settings(), {}).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HostProcess.Architecture, "x64"),
        Effect.provideService(SpawnExecutableResolution, lookup),
      );
      assert.equal(chosen, "sdk");
      assert.equal(linux, "sdk");
      assert.deepEqual(looked, []);
    }),
  );
});

describe("Cursor CLI sign-in status", () => {
  it("reads the account from `about --format json` and the older text form", () => {
    const about = (stdout: string, code = 0) => parseCursorAgentAbout({ stdout, stderr: "", code });
    assert.deepEqual(about(ABOUT_JSON).auth, {
      status: "authenticated",
      email: "dev@example.test",
      label: "Cursor Pro (CLI)",
      type: "pro",
    });
    assert.equal(about(ABOUT_JSON).version, "2026.10.01-test");
    assert.equal(about('{"cliVersion":"1","userEmail":null}').auth.status, "unauthenticated");
    const text = about(
      "About Cursor CLI\n\nCLI Version         2026.03.20\nUser Email          Not logged in\n",
    );
    assert.equal(text.version, "2026.03.20");
    assert.equal(text.auth.status, "unauthenticated");
    assert.equal(
      about("CLI Version         2026.03.20\nUser Email          dev@example.test\n").auth.email,
      "dev@example.test",
    );
  });
});

describe("Cursor CLI sign-in", () => {
  it.effect("runs `cursor-agent login` in the sign-in terminal only when asked", () =>
    Effect.gen(function* () {
      const launched = yield* Deferred.make<PtyAdapter.PtySpawnInput>();
      const pty = PtyAdapter.PtyAdapter.of({
        spawn: (input) =>
          Deferred.succeed(launched, input).pipe(
            Effect.as({
              pid: 1,
              write: () => {},
              resize: () => {},
              kill: () => {},
              onData: () => () => {},
              // Never exits: the test only checks what was started.
              onExit: () => () => {},
            }),
          ),
      });
      const auth = yield* makeCursorAgentAuth({
        instanceId: ProviderInstanceId.make("cursor_cli_auth"),
        settings: settings({ binaryPath: "/opt/cursor/cursor-agent" }),
        environment: {},
        cwd: process.cwd(),
        onChanged: () => Effect.void,
      }).pipe(
        Effect.provideService(PtyAdapter.PtyAdapter, pty),
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusingSpawner),
      );
      assert.isTrue(auth.canSignIn);
      assert.isFalse(yield* Deferred.isDone(launched));
      yield* auth.controller.start("owner");
      const input = yield* Deferred.await(launched);
      assert.equal(input.shell, "/opt/cursor/cursor-agent");
      assert.deepEqual(input.args, ["login"]);
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});

/** Stands in for upstream's SDK driver so a test can see which runtime the wrapper built. */
const makeFakeSdkDriver = (
  created: Array<ProviderInstanceId>,
): ProviderDriver<CursorSettings, never, never> => ({
  driverKind: ProviderDriverKind.make("cursor"),
  metadata: { displayName: "Cursor", supportsMultipleInstances: true },
  configSchema: undefined as never,
  defaultConfig: () => settings(),
  create: (input) =>
    Effect.sync(() => {
      created.push(input.instanceId);
      return { instanceId: input.instanceId } as ProviderInstance;
    }),
});

interface Spawned {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Records what the server asks to spawn. `cursor-agent … acp` runs the ACP mock
 * agent and `cursor-agent about` prints a signed-in account; anything else dies.
 */
const makeRecordingSpawner = (live: ChildProcessSpawner.ChildProcessSpawner["Service"]) => {
  const spawned: Array<Spawned> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command)) {
        return yield* Effect.die("Unexpected process pipeline.");
      }
      spawned.push({ command: command.command, args: command.args });
      if (NodePath.basename(command.command) !== "cursor-agent") {
        return yield* Effect.die(`Unexpected spawn: ${command.command}`);
      }
      const replacement =
        command.args.at(-1) === "acp"
          ? [mockAgentPath]
          : command.args[0] === "about"
            ? ["-e", `process.stdout.write(${JSON.stringify(ABOUT_JSON)})`]
            : undefined;
      if (replacement === undefined) {
        return yield* Effect.die(`Unexpected cursor-agent call: ${command.args.join(" ")}`);
      }
      return yield* live.spawn(
        ChildProcess.make(process.execPath, replacement, { ...command.options, shell: false }),
      );
    }),
  );
  return { spawned, spawner };
};

const turnInput = (input: {
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly providerThread: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"];
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly now: DateTime.Utc;
}): ProviderAdapter.ProviderAdapterV2TurnInput => ({
  appThread: {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: ProjectId.make(`project:${input.threadId}`),
    title: "Cursor CLI runtime test",
    providerInstanceId: input.instanceId,
    modelSelection: input.modelSelection,
    runtimeMode: input.runtimePolicy.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: input.providerThread.id,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: input.threadId },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  },
  threadId: input.threadId,
  runId: RunId.make(`run:${input.threadId}`),
  runOrdinal: 1,
  providerTurnOrdinal: 1,
  attemptId: RunAttemptId.make(`attempt:${input.threadId}`),
  rootNodeId: NodeId.make(`node:${input.threadId}`),
  providerThread: input.providerThread,
  message: {
    createdBy: "user",
    creationSource: "web",
    messageId: MessageId.make(`message:${input.threadId}`),
    text: "hello from the cursor-agent runtime test",
    attachments: [],
  },
  modelSelection: input.modelSelection,
  runtimePolicy: input.runtimePolicy,
});

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-cursor-agent-driver-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
      ),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
      ),
      Layer.provideMerge(
        Layer.succeed(
          ProviderEventLoggers.ProviderEventLoggers,
          ProviderEventLoggers.NoOpProviderEventLoggers,
        ),
      ),
      Layer.provideMerge(ModelManifest.layerTest),
      Layer.provideMerge(IdAllocator.layer),
      Layer.provideMerge(McpProviderSessions.layer),
      Layer.provideMerge(
        Layer.mock(CursorKeychain.CursorKeychain)({ accessToken: Effect.succeed(null) }),
      ),
    ),
  ),
);

it.layer(layerTest)("ViewCode Cursor driver", (it) => {
  it.effect("builds upstream's SDK runtime when the setting says sdk", () =>
    Effect.gen(function* () {
      const created: Array<ProviderInstanceId> = [];
      const driver = makeViewCodeCursorDriver(makeFakeSdkDriver(created));
      const instanceId = ProviderInstanceId.make("cursor_sdk");
      yield* driver
        .create({
          instanceId,
          displayName: undefined,
          enabled: true,
          environment: [],
          config: settings({ runtime: "sdk" }),
        })
        .pipe(
          Effect.provideService(HostProcess.Platform, "darwin"),
          Effect.provideService(SpawnExecutableResolution, () => "/usr/local/bin/cursor-agent"),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, refusingSpawner),
        );
      assert.deepEqual(created, [instanceId]);
    }).pipe(Effect.scoped),
  );

  it.effect.skipIf(windowsHost)(
    "runs a turn by spawning only cursor-agent, never rg or cursorsandbox",
    () =>
      Effect.gen(function* () {
        const live = yield* ChildProcessSpawner.ChildProcessSpawner;
        const recording = makeRecordingSpawner(live);
        const created: Array<ProviderInstanceId> = [];
        const driver = makeViewCodeCursorDriver(makeFakeSdkDriver(created));
        const instanceId = ProviderInstanceId.make("cursor_cli");
        const instance = yield* driver
          .create({
            instanceId,
            displayName: undefined,
            enabled: true,
            // Auto on macOS with cursor-agent installed picks the CLI runtime.
            config: settings(),
            environment: [
              // The mock agent refuses sessions until it is authenticated with `cursor_login`.
              { name: "T3_ACP_REQUIRE_AUTH", value: "1", sensitive: false },
              { name: "T3_ACP_AUTH_METHOD_ID", value: "cursor_login", sensitive: false },
            ],
          })
          .pipe(
            Effect.provideService(HostProcess.Platform, "darwin"),
            Effect.provideService(HostProcess.Architecture, "arm64"),
            Effect.provideService(SpawnExecutableResolution, (command) =>
              command === "cursor-agent" ? "/usr/local/bin/cursor-agent" : undefined,
            ),
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, recording.spawner),
          );
        assert.deepEqual(created, []);

        const snapshot = yield* instance.snapshot.refresh;
        assert.equal(snapshot.auth.status, "authenticated");
        assert.equal(snapshot.auth.email, "dev@example.test");
        assert.isAbove(snapshot.models.length, 0);

        const adapter = instance.orchestrationAdapter;
        const threadId = ThreadId.make("thread-cursor-cli-runtime");
        const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
          runtimeMode: "full-access",
          interactionMode: "default",
          cwd: process.cwd(),
        });
        const modelSelection = { instanceId, model: "default" } as const;
        const session = yield* adapter.openSession({
          threadId,
          providerSessionId: ProviderSessionId.make("session-cursor-cli-runtime"),
          modelSelection,
          runtimePolicy,
        });
        const providerThread = yield* session.ensureThread({
          threadId,
          modelSelection,
          runtimePolicy,
        });
        yield* session.startTurn(
          turnInput({
            threadId,
            instanceId,
            providerThread,
            runtimePolicy,
            modelSelection,
            now: yield* DateTime.now,
          }),
        );
        const events = yield* session.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminal = events.find((event) => event.type === "turn.terminal");
        assert.equal(terminal?.type === "turn.terminal" ? terminal.status : undefined, "completed");

        const executables = recording.spawned.map((entry) => NodePath.basename(entry.command));
        assert.isTrue(executables.every((name) => name === "cursor-agent"));
        assert.notInclude(executables, "rg");
        assert.notInclude(executables, "cursorsandbox");
        // Full access launches with `--force`; the turn completing also shows the
        // runtime authenticated with `cursor_login`, the only method the mock accepts.
        assert.deepInclude(
          recording.spawned.map((entry) => [NodePath.basename(entry.command), ...entry.args]),
          ["cursor-agent", "--force", "acp"],
        );
      }).pipe(Effect.scoped),
    30_000,
  );
});
