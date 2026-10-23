import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandCodeSettings,
  CheckpointId,
  ProviderTurnId,
  RuntimeRequestId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as TestProviderHost from "@t3tools/provider-testing/TestProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { makeCommandCodeAdapterV2 } from "./commandCodeAdapter.ts";

const encode = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSettings = Schema.decodeEffect(CommandCodeSettings);
const instanceId = ProviderInstanceId.make("commandCode");
const threadId = ThreadId.make("commandcode-test-thread");
const modelSelection = { instanceId, model: "default" };
const runtimePolicy = {
  cwd: "/workspace",
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;
const layer = Layer.mergeAll(
  NodeServices.layer,
  IdAllocator.layer,
  McpProviderSessions.layer,
  TestProviderHost.layer().pipe(Layer.provide(NodeServices.layer)),
);

const makeHarness = Effect.gen(function* () {
  const processes: Array<{
    readonly args: ReadonlyArray<string>;
    readonly env: NodeJS.ProcessEnv | undefined;
    readonly input: Deferred.Deferred<string>;
    readonly stdout: Queue.Queue<Uint8Array, Cause.Done>;
    readonly exit: Deferred.Deferred<ChildProcessSpawner.ExitCode>;
    killed: boolean;
  }> = [];
  const spawner = ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (!ChildProcess.isStandardCommand(command))
        return yield* Effect.die("expected standard command");
      const input = yield* Deferred.make<string>();
      const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
      const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
      const process = {
        args: command.args,
        env: command.options.env,
        input,
        stdout,
        exit,
        killed: false,
      };
      processes.push(process);
      let prompt = "";
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(999_999_999),
        exitCode: Deferred.await(exit),
        isRunning: Effect.succeed(true),
        kill: () =>
          Effect.sync(() => {
            process.killed = true;
          }).pipe(
            Effect.andThen(Queue.end(stdout)),
            Effect.andThen(Deferred.succeed(exit, ChildProcessSpawner.ExitCode(130))),
          ),
        unref: Effect.succeed(Effect.void),
        stdin: Sink.forEach((bytes: Uint8Array) =>
          Effect.sync(() => {
            prompt += new TextDecoder().decode(bytes);
          }).pipe(
            Effect.andThen(
              Effect.suspend(() => (prompt.length ? Deferred.succeed(input, prompt) : Effect.void)),
            ),
          ),
        ),
        stdout: Stream.fromQueue(stdout),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
      });
    }),
  );
  const mcp = yield* McpProviderSessions.McpProviderSessions;
  yield* mcp.set({
    environmentId: EnvironmentId.make("test-env"),
    threadId,
    providerSessionId: "cc-session",
    providerInstanceId: instanceId,
    endpoint: "http://localhost/mcp",
    authorizationHeader: "Bearer test-review-auth",
    reviewEndpoint: "http://localhost/reviews",
    reviewCliShimDir: "/tmp/review-shim",
    browserToolsAvailable: false,
  });
  const adapter = yield* makeCommandCodeAdapterV2({
    instanceId,
    settings: yield* decodeSettings({ enabled: true }),
    environment: {},
  }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("cc-session"),
    modelSelection,
    runtimePolicy,
  });
  const emitted = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) => Queue.offer(emitted, event)),
    Effect.forkScoped,
  );
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const start = (thread: OrchestrationV2ProviderThread = providerThread, ordinal = 1) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const appThread: OrchestrationV2AppThread = {
        id: threadId,
        projectId: ProjectId.make("project-test"),
        createdBy: "user",
        creationSource: "web",
        title: "Command Code",
        providerInstanceId: instanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, rootThreadId: threadId, relationshipToParent: null },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledAt: null,
        settledOverride: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      yield* runtime.startTurn({
        appThread,
        threadId,
        runId: RunId.make(`run-${ordinal}`),
        runOrdinal: ordinal,
        providerTurnOrdinal: ordinal,
        attemptId: RunAttemptId.make(`attempt-${ordinal}`),
        rootNodeId: NodeId.make(`node-${ordinal}`),
        providerThread: thread,
        modelSelection,
        runtimePolicy,
        message: {
          messageId: MessageId.make(`message-${ordinal}`),
          text: "secret prompt goes on stdin",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      });
      return processes[processes.length - 1]!;
    });
  const finish = (frames: ReadonlyArray<unknown>, code = 0) =>
    Effect.gen(function* () {
      const process = processes[processes.length - 1]!;
      yield* Queue.offer(
        process.stdout,
        new TextEncoder().encode(frames.map((frame) => encode(frame)).join("\n") + "\n"),
      );
      yield* Queue.end(process.stdout);
      yield* Deferred.succeed(process.exit, ChildProcessSpawner.ExitCode(code));
      const result: Array<ProviderAdapter.ProviderAdapterV2Event> = [];
      while (true) {
        const event = yield* Queue.take(emitted);
        result.push(event);
        if (event.type === "turn.terminal") return result;
      }
    });
  return { adapter, runtime, providerThread, start, finish, emitted };
});

const event = (frame: Record<string, unknown>) => ({ type: "event", event: frame });

describe("Command Code v2 adapter", () => {
  it.effect("rejects unsupported native operations instead of reporting success", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const capabilities = yield* h.adapter.getCapabilities();
      assert.isFalse(capabilities.turns.supportsActiveSteering);
      assert.isFalse(capabilities.turns.supportsSteeringByInterruptRestart);
      assert.isFalse(capabilities.threads.canReadThreadSnapshot);
      assert.isFalse(capabilities.threads.canRollbackThread);
      assert.isFalse(capabilities.threads.canForkThread);
      assert.isFalse(capabilities.approvals.supportsCommandApproval);
      assert.isFalse(capabilities.tools.supportsMcpTools);
      const steer = yield* h.runtime
        .steerTurn({
          threadId,
          runId: RunId.make("run-unsupported"),
          providerThread: h.providerThread,
          providerTurnId: ProviderTurnId.make("turn-unsupported"),
          message: {
            messageId: MessageId.make("message-unsupported"),
            createdBy: "user",
            creationSource: "web",
            text: "follow up",
            attachments: [],
          },
        })
        .pipe(Effect.result);
      assert.equal(steer._tag, "Failure");
      if (steer._tag === "Failure")
        assert.equal(steer.failure._tag, "ProviderAdapterSteerRunUnsupportedError");
      const operations = [
        h.runtime.readThreadSnapshot({ providerThread: h.providerThread }),
        h.runtime.rollbackThread({
          providerThread: h.providerThread,
          target: {
            type: "thread_start",
            checkpointId: CheckpointId.make("checkpoint-unsupported"),
            appRunOrdinal: 0,
          },
          providerThreadTurns: [],
        }),
        h.runtime.forkThread({
          sourceProviderThread: h.providerThread,
          targetThreadId: ThreadId.make("fork-unsupported"),
        }),
        h.runtime.respondToRuntimeRequest({
          requestId: RuntimeRequestId.make("request-unsupported"),
          response: {},
        }),
      ];
      for (const operation of operations) {
        const result = yield* operation.pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.equal(result.failure._tag, "ProviderAdapterProtocolError");
      }
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect(
    "projects native frames and resumes with portable context, keeping prompts out of argv",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness;
        yield* h.runtime.injectHistory!({
          providerThread: h.providerThread,
          messages: [
            {
              role: "user",
              text: "Forked user message from the source thread",
              threadId: ThreadId.make("source-thread"),
              runId: null,
              itemId: TurnItemId.make("item-1"),
              providerThreadId: null,
              status: "completed",
              kind: "message",
            },
          ],
          context: "Earlier conversation context",
        });
        const first = yield* h.start();
        assert.equal(first.env?.VIEWCODE_REVIEW_ENDPOINT, "http://localhost/reviews");
        assert.equal(first.env?.VIEWCODE_REVIEW_AUTH, "test-review-auth");
        assert.include(first.env?.PATH ?? "", "/tmp/review-shim");
        const prompt = yield* Deferred.await(first.input);
        assert.include(prompt, "Earlier conversation context");
        assert.include(prompt, "Forked user message from the source thread");
        assert.include(prompt, "secret prompt goes on stdin");
        assert.isFalse(first.args.some((arg) => arg.includes("secret prompt")));
        assert.include(first.args, "--yolo");
        const events = yield* h.finish([
          event({ type: "run_start", sessionId: "native-cc-1" }),
          event({ type: "thinking_delta", delta: "Thinking" }),
          event({ type: "thinking_end" }),
          event({ type: "text_delta", delta: "Hello " }),
          event({ type: "text_delta", delta: "world" }),
          event({ type: "message_end" }),
          event({
            type: "tool_queued",
            toolCallId: "shell-1",
            toolName: "shell_command",
            input: { command: "pwd" },
          }),
          event({
            type: "tool_completed",
            toolCallId: "shell-1",
            toolName: "shell_command",
            result: [{ type: "text", text: "/workspace" }],
          }),
          event({ type: "model_request_end", usage: { inputTokens: 100, outputTokens: 10 } }),
          {
            type: "result",
            subtype: "success",
            sessionId: "native-cc-1",
            usage: { inputTokens: 100, outputTokens: 10 },
          },
        ]);
        const messages = events.filter((e) => e.type === "message.updated");
        assert.equal(messages.at(-1)?.message.text, "Hello world");
        assert.isFalse(messages.at(-1)?.message.streaming);
        const turn = events.findLast((e) => e.type === "provider_turn.updated")!;
        assert.equal(turn.providerTurn.turnTokenUsage?.inputTokens, 100);
        assert.isTrue(
          events.some(
            (e) =>
              e.type === "turn_item.updated" &&
              e.turnItem.type === "command_execution" &&
              e.turnItem.status === "completed",
          ),
        );
        const thread = events.findLast((e) => e.type === "provider_thread.updated")!.providerThread;
        assert.equal(thread.nativeThreadRef?.nativeId, "native-cc-1");
        const second = yield* h.start(thread, 2);
        assert.include(second.args, "--resume");
        assert.include(second.args, "native-cc-1");
        assert.notInclude(yield* Deferred.await(second.input), "Earlier conversation context");
        yield* h.finish([{ type: "result", subtype: "success", finalText: "Follow-up" }]);
        assert.isFalse((yield* h.adapter.getCapabilities()).turns.supportsActiveSteering);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("fails early auth errors and closes unfinished tools", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      yield* h.start();
      const events = yield* h.finish(
        [
          event({
            type: "tool_queued",
            toolCallId: "tool",
            toolName: "write_file",
            input: { path: "file.ts" },
          }),
          { type: "result", subtype: "error", error: "Sign in required" },
        ],
        3,
      );
      const terminal = events.at(-1)!;
      assert.isTrue(
        terminal.type === "turn.terminal" &&
          terminal.status === "failed" &&
          terminal.failure?.message === "Sign in required",
      );
      assert.isTrue(
        events.some(
          (e) =>
            e.type === "turn_item.updated" &&
            e.turnItem.type === "file_change" &&
            e.turnItem.status === "failed",
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("stop kills the captured process and emits one interrupted terminal", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness;
      const process = yield* h.start();
      const started = yield* Queue.take(h.emitted);
      assert.isTrue(started.type === "provider_turn.updated");
      if (started.type !== "provider_turn.updated") return;
      yield* h.runtime.interruptTurn({
        providerThread: h.providerThread,
        providerTurnId: started.providerTurn.id,
      });
      assert.isTrue(process.killed);
      let terminal: ProviderAdapter.ProviderAdapterV2Event;
      do {
        terminal = yield* Queue.take(h.emitted);
      } while (terminal.type !== "turn.terminal");
      assert.equal(terminal.status, "interrupted");
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
