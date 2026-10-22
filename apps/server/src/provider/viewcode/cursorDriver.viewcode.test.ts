// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
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
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
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
import { CURSOR_AGENT_PROMPT_STALL_TIMEOUT } from "./cursorAgentAcpSupport.ts";
import { makeViewCodeCursorDriver } from "./cursorDriver.ts";

const windowsHost = HostProcess.Platform.defaultValue() === "win32";
const mockAgentPath = NodePath.resolve(import.meta.dirname, "../../../scripts/acp-mock-agent.ts");
const ABOUT_JSON = JSON.stringify({ cliVersion: "2026.10.01-test", userEmail: "dev@example.test" });
const LOST_LOGIN = "Authentication required. Please run 'cursor-agent login' first.";

const settings: CursorSettings = { enabled: true, customModels: [] };

const unusedSdkDriver: ProviderDriver<CursorSettings, never, never> = {
  driverKind: ProviderDriverKind.make("cursor"),
  metadata: { displayName: "Cursor", supportsMultipleInstances: true },
  configSchema: undefined as never,
  defaultConfig: () => settings,
  create: () => Effect.die("The cursor-agent runtime must not build the SDK driver."),
};

const turnInput = (input: {
  readonly ordinal: number;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  readonly providerThread: ProviderAdapter.ProviderAdapterV2TurnInput["providerThread"];
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly modelSelection: ModelSelection;
  readonly now: DateTime.Utc;
}): ProviderAdapter.ProviderAdapterV2TurnInput => {
  const suffix = `${input.threadId}:${input.ordinal}`;
  return {
    appThread: {
      createdBy: "user",
      creationSource: "web",
      id: input.threadId,
      projectId: ProjectId.make(`project:${input.threadId}`),
      title: "Cursor CLI after sleep",
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
    runId: RunId.make(`run:${suffix}`),
    runOrdinal: input.ordinal,
    providerTurnOrdinal: input.ordinal,
    attemptId: RunAttemptId.make(`attempt:${suffix}`),
    rootNodeId: NodeId.make(`node:${suffix}`),
    providerThread: input.providerThread,
    message: {
      createdBy: "user",
      creationSource: "web",
      messageId: MessageId.make(`message:${suffix}`),
      text: "hello after the lid opened",
      attachments: [],
    },
    modelSelection: input.modelSelection,
    runtimePolicy: input.runtimePolicy,
  };
};

const layerTest = ProviderHostLive.layer.pipe(
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-cursor-agent-sleep-" }).pipe(
      Layer.provideMerge(NodeServices.layer),
      Layer.provideMerge(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("Unexpected HTTP request")),
        ),
      ),
      Layer.provideMerge(ServerSettings.layerTest()),
      Layer.provideMerge(
        // No client is asking for background work, as when the page is closed or paused.
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

/**
 * `cursor-agent about` prints a signed-in account; `cursor-agent acp` runs the
 * mock agent with the environment `acpEnv` returns for that process.
 */
const cursorAgentSpawner = (input: {
  readonly onAbout: Effect.Effect<void>;
  readonly acpEnv: () => Record<string, string>;
}) =>
  Effect.map(ChildProcessSpawner.ChildProcessSpawner, (live) =>
    ChildProcessSpawner.make((command) =>
      Effect.gen(function* () {
        if (!ChildProcess.isStandardCommand(command)) {
          return yield* Effect.die("Unexpected process pipeline.");
        }
        if (NodePath.basename(command.command) !== "cursor-agent") {
          return yield* Effect.die(`Unexpected spawn: ${command.command}`);
        }
        if (command.args[0] === "about") {
          yield* input.onAbout;
          return yield* live.spawn(
            ChildProcess.make(
              process.execPath,
              ["-e", `process.stdout.write(${JSON.stringify(ABOUT_JSON)})`],
              { ...command.options, shell: false },
            ),
          );
        }
        if (command.args.at(-1) !== "acp") {
          return yield* Effect.die(`Unexpected cursor-agent call: ${command.args.join(" ")}`);
        }
        const options = command.options;
        return yield* live.spawn(
          ChildProcess.make(process.execPath, [mockAgentPath], {
            ...options,
            shell: false,
            env: { ...options.env, ...input.acpEnv() },
          }),
        );
      }),
    ),
  );

/**
 * A Cursor CLI instance with one open thread; `runTurn` sends a message and
 * returns its terminal event. The status check's model probe is an `acp` process
 * too, so `beforeSession` runs once that probe is done.
 */
const openCursorCliThread = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  name: string,
  options: {
    readonly beforeSession: () => void;
    readonly onEvent?: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>;
  },
) =>
  Effect.gen(function* () {
    const instanceId = ProviderInstanceId.make(`cursor_cli_${name}`);
    const instance: ProviderInstance = yield* makeViewCodeCursorDriver(unusedSdkDriver)
      .create({
        instanceId,
        displayName: undefined,
        enabled: true,
        config: settings,
        environment: [
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
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      );
    assert.equal((yield* instance.snapshot.refresh).auth.status, "authenticated");
    options.beforeSession();

    const threadId = ThreadId.make(`thread-cursor-cli-${name}`);
    const runtimePolicy = ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: process.cwd(),
    });
    const modelSelection = { instanceId, model: "default" } as const;
    const session = yield* instance.orchestrationAdapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make(`session-cursor-cli-${name}`),
      modelSelection,
      runtimePolicy,
    });
    const providerThread = yield* session.ensureThread({ threadId, modelSelection, runtimePolicy });
    const runTurn = (ordinal: number) =>
      Effect.gen(function* () {
        yield* session.startTurn(
          turnInput({
            ordinal,
            threadId,
            instanceId,
            providerThread,
            runtimePolicy,
            modelSelection,
            now: yield* DateTime.now,
          }),
        );
        const events = yield* session.events.pipe(
          Stream.tap(options.onEvent ?? (() => Effect.void)),
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const terminal = events.find((event) => event.type === "turn.terminal");
        if (terminal?.type !== "turn.terminal") return yield* Effect.die("No terminal event");
        return terminal;
      });
    return { runTurn };
  });

it.layer(layerTest)("ViewCode Cursor CLI after sleep", (it) => {
  it.effect.skipIf(windowsHost)(
    "replaces a cursor-agent that lost its login and re-checks the sign-in",
    () =>
      Effect.gen(function* () {
        const acpProcesses: Array<"lost-login" | "fresh"> = [];
        // The process that was running before the lid closed keeps a lost
        // login in memory; a new one (like the user's terminal) is fine.
        let nextAcpLostLogin = false;
        let aboutRuns = 0;
        const recheckedAfterFailure = yield* Deferred.make<void>();
        let failureSeen = false;
        const spawner = yield* cursorAgentSpawner({
          onAbout: Effect.suspend(() => {
            aboutRuns += 1;
            return failureSeen
              ? Deferred.succeed(recheckedAfterFailure, undefined).pipe(Effect.asVoid)
              : Effect.void;
          }),
          acpEnv: () => {
            const lostLogin = nextAcpLostLogin;
            nextAcpLostLogin = false;
            acpProcesses.push(lostLogin ? "lost-login" : "fresh");
            return lostLogin ? { T3_ACP_FAIL_PROMPT_MESSAGE: LOST_LOGIN } : {};
          },
        });
        const { runTurn } = yield* openCursorCliThread(spawner, "sleep", {
          beforeSession: () => {
            nextAcpLostLogin = true;
          },
        });

        failureSeen = true;
        const failed = yield* runTurn(1);
        assert.equal(failed.status, "failed");
        const message = failed.status === "failed" ? (failed.failure?.message ?? "") : "";
        assert.include(message, "next message starts a fresh one");
        // The sign-in is checked again although no client is asking for status.
        yield* Deferred.await(recheckedAfterFailure);
        assert.isAtLeast(aboutRuns, 2);

        const recovered = yield* runTurn(2);
        assert.equal(recovered.status, "completed");
        assert.deepEqual(acpProcesses.slice(-2), ["lost-login", "fresh"]);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(windowsHost)(
    "ends a turn cursor-agent stopped answering and replaces the process without resending",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const logDirectory = yield* fileSystem.makeTempDirectoryScoped({
          prefix: "t3-cursor-agent-stall-",
        });
        const requestLogs: Array<string> = [];
        const acpProcesses: Array<"stalled" | "fresh"> = [];
        // The first process answers the prompt with one chunk and then nothing,
        // like a CLI whose connection died while the Mac slept.
        let nextAcpStalls = false;
        const spawner = yield* cursorAgentSpawner({
          onAbout: Effect.void,
          acpEnv: () => {
            const stalls = nextAcpStalls;
            nextAcpStalls = false;
            acpProcesses.push(stalls ? "stalled" : "fresh");
            const requestLog = NodePath.join(logDirectory, `acp-${requestLogs.length}.ndjson`);
            requestLogs.push(requestLog);
            return {
              T3_ACP_REQUEST_LOG_PATH: requestLog,
              ...(stalls ? { T3_ACP_EMIT_CONTENT_THEN_HANG: "1" } : {}),
            };
          },
        });
        const partialArrived = yield* Deferred.make<void>();
        const { runTurn } = yield* openCursorCliThread(spawner, "stall", {
          beforeSession: () => {
            nextAcpStalls = true;
            acpProcesses.length = 0;
          },
          onEvent: (event) =>
            event.type === "message.updated" && event.message.role === "assistant"
              ? Deferred.succeed(partialArrived, undefined).pipe(Effect.asVoid)
              : Effect.void,
        });

        const stalledTurn = yield* runTurn(1).pipe(Effect.forkScoped);
        // The agent's last frame; from here it is silent.
        yield* Deferred.await(partialArrived);
        yield* TestClock.adjust(CURSOR_AGENT_PROMPT_STALL_TIMEOUT);
        const stalled = yield* Fiber.join(stalledTurn);
        assert.equal(stalled.status, "failed");
        assert.equal(
          stalled.status === "failed" ? stalled.failure?.message : undefined,
          "Cursor stopped responding; send it again.",
        );
        assert.deepEqual(acpProcesses, ["stalled"]);

        const next = yield* runTurn(2);
        assert.equal(next.status, "completed");
        assert.deepEqual(acpProcesses, ["stalled", "fresh"]);
        // Each process saw exactly one prompt: the stalled one was never sent again.
        const promptsPerProcess = yield* Effect.forEach(requestLogs.slice(-2), (log) =>
          fileSystem
            .readFileString(log)
            .pipe(
              Effect.map(
                (text) =>
                  text.split("\n").filter((line) => line.includes('"session/prompt"')).length,
              ),
            ),
        );
        assert.deepEqual(promptsPerProcess, [1, 1]);
      }).pipe(Effect.scoped),
    30_000,
  );

  it.effect.skipIf(windowsHost)("does not end a turn while a tool cursor-agent reported runs", () =>
    Effect.gen(function* () {
      let nextAcpRunsTool = false;
      const spawner = yield* cursorAgentSpawner({
        onAbout: Effect.void,
        acpEnv: () => {
          const runsTool = nextAcpRunsTool;
          nextAcpRunsTool = false;
          // A build or `delegate_task` can be silent far longer than the stall bound.
          return runsTool ? { T3_ACP_EMIT_ACTIVE_TOOL_THEN_HANG: "1" } : {};
        },
      });
      const toolStarted = yield* Deferred.make<void>();
      let ended = false;
      const { runTurn } = yield* openCursorCliThread(spawner, "tool", {
        beforeSession: () => {
          nextAcpRunsTool = true;
        },
        onEvent: (event) =>
          Effect.sync(() => {
            if (event.type === "turn.terminal") ended = true;
          }).pipe(
            Effect.andThen(
              event.type === "turn_item.updated"
                ? Deferred.succeed(toolStarted, undefined)
                : Effect.void,
            ),
          ),
      });

      const turn = yield* runTurn(1).pipe(Effect.forkScoped);
      yield* Deferred.await(toolStarted);
      yield* TestClock.adjust(Duration.times(CURSOR_AGENT_PROMPT_STALL_TIMEOUT, 3));
      assert.isFalse(ended);
      yield* Fiber.interrupt(turn);
    }).pipe(Effect.scoped),
  );
});
