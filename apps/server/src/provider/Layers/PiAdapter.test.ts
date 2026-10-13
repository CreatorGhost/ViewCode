// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  EnvironmentId,
  PiSettings,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { parsePiCommands, parsePiCompactCommand, parsePiModels } from "../piRpc.ts";
import { makePiAdapter } from "./PiAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/pi-mock-agent.ts");
const decodePiSettings = Schema.decodeSync(PiSettings);
const instanceId = ProviderInstanceId.make("pi");

async function makeMockPi(extraEnv: Record<string, string> = {}) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-rpc-mock-"));
  const logPath = NodePath.join(directory, "commands.ndjson");
  const argvLogPath = NodePath.join(directory, "argv.log");
  const binaryPath = writeFakeCli({
    directory,
    name: "fake-pi",
    env: {
      PI_MOCK_LOG: logPath,
      PI_MOCK_SESSION_FILE: NodePath.join(directory, "session.jsonl"),
      ...extraEnv,
    },
    source: execScriptSource({ scriptPath: mockAgentPath, argvLogPath }),
  });
  return { binaryPath, logPath, argvLogPath, directory };
}

async function readCommands(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const makeAdapter = (binaryPath: string) =>
  makePiAdapter(decodePiSettings({ binaryPath }), { instanceId, environment: process.env });

/** Collects the adapter's events and resolves once a turn completes. */
const watchEvents = (adapter: Effect.Success<ReturnType<typeof makeAdapter>>) =>
  Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const completed = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const fiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        if (event.type === "turn.completed") yield* Queue.offer(completed, event);
      }),
    ).pipe(Effect.forkChild);
    return { events, nextCompletion: Queue.take(completed), stop: Fiber.interrupt(fiber) };
  });

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "t3code-pi-adapter-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
);

it("reads Pi's models with their thinking levels", () => {
  const models = parsePiModels(
    {
      models: [
        { provider: "anthropic", id: "claude-sonnet-5", name: "Claude Sonnet 5", reasoning: true },
        {
          provider: "openai",
          id: "gpt-6-sol",
          name: "GPT-6 Sol",
          reasoning: true,
          thinkingLevelMap: { xhigh: "xhigh", minimal: null },
        },
        { provider: "local", id: "tiny", reasoning: false },
      ],
    },
    { model: { provider: "anthropic", id: "claude-sonnet-5" }, thinkingLevel: "high" },
  );
  assert.deepStrictEqual(
    models.map((model) => model.slug),
    ["anthropic/claude-sonnet-5", "openai/gpt-6-sol", "local/tiny"],
  );
  const levels = (index: number) =>
    models[index]?.capabilities?.optionDescriptors?.flatMap((descriptor) =>
      descriptor.type === "select" ? descriptor.options.map((option) => option.id) : [],
    );
  assert.deepStrictEqual(levels(0), ["off", "minimal", "low", "medium", "high"]);
  assert.deepStrictEqual(levels(1), ["off", "low", "medium", "high", "xhigh"]);
  assert.deepStrictEqual(levels(2), []);
});

it("maps /compact and Pi's commands", () => {
  assert.deepStrictEqual(parsePiCompactCommand("/compact"), {});
  assert.deepStrictEqual(parsePiCompactCommand("/compact keep the API notes"), {
    customInstructions: "keep the API notes",
  });
  assert.isNull(parsePiCompactCommand("/compactor"));
  const { slashCommands, skills } = parsePiCommands({
    commands: [
      { name: "review", source: "prompt" },
      { name: "skill:release", source: "skill", sourceInfo: { path: "/skills/release" } },
    ],
  });
  assert.deepStrictEqual(
    slashCommands.map((command) => command.name),
    ["compact", "review"],
  );
  assert.deepStrictEqual(skills, [{ name: "release", path: "/skills/release", enabled: true }]);
});

it.layer(testLayer)("PiAdapter", (it) => {
  it.effect("runs a turn with the picked model, ViewCode tools and the extension loaded", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockPi());
      const adapter = yield* makeAdapter(mock.binaryPath);
      const watch = yield* watchEvents(adapter);
      const threadId = ThreadId.make("pi-turn");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("test-environment"),
        threadId,
        providerInstanceId: instanceId,
        providerSessionId: "test-session",
        endpoint: "http://127.0.0.1:1234/mcp",
        authorizationHeader: "Bearer test-token",
        capabilities: new Set(),
      });
      const session = yield* adapter
        .startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "approval-required",
          modelSelection: {
            instanceId,
            model: "openai/gpt-6-sol",
            options: [{ id: "thinking", value: "high" }],
          },
        })
        .pipe(
          Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
        );
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionFile: NodePath.join(mock.directory, "session.jsonl"),
      });
      const { turnId } = yield* adapter.sendTurn({ threadId, input: "hello" });
      const completion = yield* watch.nextCompletion;
      yield* adapter.stopSession(threadId);
      yield* watch.stop;

      assert.equal(completion.turnId, turnId);
      assert.deepStrictEqual(completion.payload, { state: "completed", stopReason: "stop" });
      const turnEvents = watch.events.filter((event) => event.turnId === turnId);
      const deltas = turnEvents.flatMap((event) =>
        event.type === "content.delta" ? [[event.payload.streamKind, event.payload.delta]] : [],
      );
      assert.deepStrictEqual(deltas[0], ["reasoning_text", "Thinking."]);
      assert.equal(deltas[1]?.[0], "assistant_text");
      // The first prompt of a process carries ViewCode's runtime instructions.
      assert.include(deltas[1]?.[1] ?? "", "Echo: hello");
      assert.include(deltas[1]?.[1] ?? "", "<runtime_info>");
      const usage = turnEvents.find((event) => event.type === "thread.token-usage.updated");
      assert.deepInclude(usage?.payload, {
        usage: {
          usedTokens: 1250,
          lastUsedTokens: 1250,
          lastInputTokens: 1200,
          lastOutputTokens: 50,
          lastCachedInputTokens: 200,
          // From set_model's answer for the picked model.
          maxTokens: 100_000,
        },
      });

      const argv = yield* Effect.promise(() => NodeFSP.readFile(mock.argvLogPath, "utf8"));
      const args = argv.trim().split("\t");
      assert.deepStrictEqual(args.slice(0, 3), ["--mode", "rpc", "--extension"]);
      assert.match(args[3] ?? "", /viewcode-extension\.mjs$/);
      const commands = yield* Effect.promise(() => readCommands(mock.logPath));
      assert.deepStrictEqual(commands[0], {
        type: "__env",
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        mcp: JSON.stringify({
          url: "http://127.0.0.1:1234/mcp",
          headers: { Authorization: "Bearer test-token" },
        }),
        mode: "approval-required",
      });
      assert.deepStrictEqual(
        commands.slice(1).map((command) => command.type),
        ["get_state", "set_model", "set_thinking_level", "prompt"],
      );
      assert.deepInclude(commands[2], { provider: "openai", modelId: "gpt-6-sol" });
      assert.deepInclude(commands[3], { level: "high" });
    }),
  );

  it.effect("resumes the session file and turns Pi's confirm into an approval", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockPi({ PI_MOCK_CONFIRM: "1" }));
      const adapter = yield* makeAdapter(mock.binaryPath);
      const watch = yield* watchEvents(adapter);
      const threadId = ThreadId.make("pi-approval");
      const approved = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened" && event.requestId
          ? adapter
              .respondToRequest(threadId, ApprovalRequestId.make(event.requestId), "accept")
              .pipe(Effect.andThen(Deferred.succeed(approved, undefined)))
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: { schemaVersion: 1, sessionFile: "/sessions/earlier.jsonl" },
      });
      yield* adapter.sendTurn({ threadId, input: "list files" });
      yield* Deferred.await(approved);
      yield* watch.nextCompletion;
      yield* adapter.stopSession(threadId);
      yield* watch.stop;

      const argv = yield* Effect.promise(() => NodeFSP.readFile(mock.argvLogPath, "utf8"));
      assert.deepStrictEqual(argv.trim().split("\t").slice(0, 4), [
        "--mode",
        "rpc",
        "--session",
        "/sessions/earlier.jsonl",
      ]);
      const opened = watch.events.find((event) => event.type === "request.opened");
      assert.equal(
        opened?.type === "request.opened" ? opened.payload.requestType : undefined,
        "command_execution_approval",
      );
      const commands = yield* Effect.promise(() => readCommands(mock.logPath));
      assert.deepInclude(
        commands.find((command) => command.type === "extension_ui_response"),
        { id: "dialog-1", confirmed: true },
      );
      const tool = watch.events.find(
        (event) =>
          event.type === "item.completed" && event.payload.itemType === "command_execution",
      );
      assert.equal(tool?.type === "item.completed" ? tool.payload.status : undefined, "completed");
    }),
  );

  it.effect("steers a running turn, then stops it", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockPi({ PI_MOCK_HANG: "1" }));
      const adapter = yield* makeAdapter(mock.binaryPath);
      const watch = yield* watchEvents(adapter);
      const threadId = ThreadId.make("pi-steer");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      const first = yield* adapter.sendTurn({ threadId, input: "start" });
      const second = yield* adapter.sendTurn({ threadId, input: "also this" });
      yield* adapter.interruptTurn(threadId);
      const completion = yield* watch.nextCompletion;
      yield* adapter.stopSession(threadId);
      yield* watch.stop;

      assert.equal(second.turnId, first.turnId);
      assert.equal(
        completion.type === "turn.completed" ? completion.payload.state : undefined,
        "cancelled",
      );
      const commands = yield* Effect.promise(() => readCommands(mock.logPath));
      assert.deepInclude(
        commands.find((command) => command.type === "steer"),
        { message: "also this" },
      );
      assert.isTrue(commands.some((command) => command.type === "abort"));
    }),
  );

  it.effect("fails the turn with Pi's model error", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockPi({ PI_MOCK_FAIL: "1" }));
      const adapter = yield* makeAdapter(mock.binaryPath);
      const watch = yield* watchEvents(adapter);
      const threadId = ThreadId.make("pi-fail");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "hello" });
      const completion = yield* watch.nextCompletion;
      yield* adapter.stopSession(threadId);
      yield* watch.stop;
      assert.deepStrictEqual(completion.payload, {
        state: "failed",
        errorMessage: "403 The API key is invalid.",
      });
    }),
  );

  it.effect("runs /compact as Pi's RPC compact", () =>
    Effect.gen(function* () {
      const mock = yield* Effect.promise(() => makeMockPi());
      const adapter = yield* makeAdapter(mock.binaryPath);
      const watch = yield* watchEvents(adapter);
      const threadId = ThreadId.make("pi-compact");
      yield* adapter.startSession({ threadId, cwd: process.cwd(), runtimeMode: "full-access" });
      yield* adapter.sendTurn({ threadId, input: "/compact keep the API notes" });
      const completion = yield* watch.nextCompletion;
      yield* adapter.stopSession(threadId);
      yield* watch.stop;
      assert.equal(
        completion.type === "turn.completed" ? completion.payload.state : undefined,
        "completed",
      );
      const commands = yield* Effect.promise(() => readCommands(mock.logPath));
      assert.deepInclude(
        commands.find((command) => command.type === "compact"),
        { customInstructions: "keep the API notes" },
      );
      assert.isFalse(commands.some((command) => command.type === "prompt"));
    }),
  );
});
