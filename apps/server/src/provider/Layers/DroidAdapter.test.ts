// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  ApprovalRequestId,
  DroidSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { execScriptSource, writeFakeCli } from "../../testUtils/fakeCli.ts";
import { droidAutonomyLevel, parseDroidModelList } from "../acp/DroidAcpSupport.ts";
import { makeDroidAdapter } from "./DroidAdapter.ts";

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const decodeDroidSettings = Schema.decodeSync(DroidSettings);
const instanceId = ProviderInstanceId.make("droid");

async function makeMockDroid(extraEnv: Record<string, string>) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "droid-acp-mock-"));
  const requestLogPath = NodePath.join(directory, "requests.ndjson");
  const binaryPath = await writeFakeCli({
    directory,
    name: "fake-droid",
    env: { T3_ACP_DROID: "1", T3_ACP_REQUEST_LOG_PATH: requestLogPath, ...extraEnv },
    source: execScriptSource({ scriptPath: mockAgentPath }),
  });
  return { binaryPath, requestLogPath };
}

async function readRequests(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as { method?: string; params?: Record<string, unknown> });
}

const makeAdapter = (binaryPath: string, environment: NodeJS.ProcessEnv = process.env) =>
  makeDroidAdapter(decodeDroidSettings({ binaryPath }), { instanceId, environment }).pipe(
    Effect.orDie,
  );

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-droid-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

it("maps runtime modes to Droid autonomy levels under the org cap", () => {
  const allowed = ["normal", "spec", "auto-low", "auto-medium"];
  const level = (runtimeMode: Parameters<typeof droidAutonomyLevel>[0]["runtimeMode"]) =>
    droidAutonomyLevel({ runtimeMode, interactionMode: undefined, allowed });
  assert.equal(level("approval-required"), "normal");
  assert.equal(level("auto-accept-edits"), "auto-low");
  assert.equal(level("auto"), "auto-medium");
  // auto-high is capped, so full access gets the most permissive level allowed.
  assert.equal(level("full-access"), "auto-medium");
  assert.equal(
    droidAutonomyLevel({ runtimeMode: "full-access", interactionMode: "plan", allowed }),
    "spec",
  );
});

it("reads built-in and custom models from Droid's model listing", () => {
  const models = parseDroidModelList(
    [
      "Invalid model: ?",
      "",
      "Available built-in models:",
      "  auto, claude-opus-5-5, gpt-6-sol",
      "",
      "Available custom models:",
      "  custom:My-Llama-0 (My Llama)",
      "",
      "Note: Custom models are loaded from ~/.factory/settings.json",
    ].join("\n"),
  );
  assert.deepStrictEqual(
    models.map((model) => [model.slug, model.name]),
    [
      ["auto", "auto"],
      ["claude-opus-5-5", "claude-opus-5-5"],
      ["gpt-6-sol", "gpt-6-sol"],
      ["custom:My-Llama-0", "My Llama"],
    ],
  );
  assert.deepStrictEqual(parseDroidModelList("No custom models configured."), []);
});

it.layer(testLayer)("DroidAdapter", (it) => {
  it.effect(
    "signs in with FACTORY_API_KEY before the session, then applies model and autonomy",
    () =>
      Effect.gen(function* () {
        const { binaryPath, requestLogPath } = yield* Effect.promise(() =>
          makeMockDroid({ T3_ACP_REQUIRE_AUTH: "1", FACTORY_API_KEY: "fk-test" }),
        );
        const adapter = yield* makeAdapter(binaryPath, {
          ...process.env,
          FACTORY_API_KEY: "fk-test",
        });
        const threadId = ThreadId.make("droid-auth");
        yield* adapter.startSession({
          threadId,
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId, model: "claude-opus-5-5" },
        });
        yield* adapter.sendTurn({ threadId, input: "plan it", interactionMode: "plan" });
        yield* adapter.stopSession(threadId);

        const requests = yield* Effect.promise(() => readRequests(requestLogPath));
        assert.deepStrictEqual(
          requests.flatMap((request) =>
            request.method === "initialize" ||
            request.method === "authenticate" ||
            request.method === "session/new"
              ? [request.method]
              : [],
          ),
          ["initialize", "authenticate", "session/new"],
        );
        assert.equal(
          requests.find((request) => request.method === "authenticate")?.params?.methodId,
          "factory-api-key",
        );
        const configWrites = requests
          .filter((request) => request.method === "session/set_config_option")
          .map((request) => [request.params?.configId, request.params?.value]);
        assert.deepStrictEqual(configWrites, [
          ["model", "claude-opus-5-5"],
          // Full access, capped by the org at auto-medium.
          ["autonomy_level", "auto-medium"],
          // The Plan turn switches to Droid's read-only spec mode.
          ["autonomy_level", "spec"],
        ]);
      }),
  );

  it.effect("leaves sign-in to Droid's stored login when no key is set", () =>
    Effect.gen(function* () {
      const { binaryPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockDroid({ T3_ACP_REQUIRE_AUTH: "1" }),
      );
      const environment = { ...process.env };
      delete environment.FACTORY_API_KEY;
      const adapter = yield* makeAdapter(binaryPath, environment);
      const error = yield* adapter
        .startSession({
          threadId: ThreadId.make("droid-no-login"),
          cwd: process.cwd(),
          runtimeMode: "approval-required",
        })
        .pipe(Effect.flip);
      assert.include(error.message, "Authentication required");
      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      assert.isFalse(requests.some((request) => request.method === "authenticate"));
    }),
  );

  it.effect("hands Droid the ViewCode tools as a stdio server and resumes natively", () =>
    Effect.gen(function* () {
      const { binaryPath, requestLogPath } = yield* Effect.promise(() => makeMockDroid({}));
      const adapter = yield* makeAdapter(binaryPath);
      const threadId = ThreadId.make("droid-mcp");
      const events: Array<ProviderRuntimeEvent> = [];
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => void events.push(event)),
      ).pipe(Effect.forkChild);
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("test-environment"),
        threadId,
        providerInstanceId: instanceId,
        providerSessionId: "test-session",
        endpoint: "http://127.0.0.1:1234/mcp",
        authorizationHeader: "Bearer test-token",
        stdioBridge: { command: "node", args: ["bridge.mjs", "--url", "x"], env: { T: "1" } },
        capabilities: new Set(),
      });
      const session = yield* adapter
        .startSession({ threadId, cwd: process.cwd(), runtimeMode: "approval-required" })
        .pipe(
          Effect.ensuring(Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId))),
        );
      yield* adapter.stopSession(threadId);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        resumeCursor: session.resumeCursor,
      });
      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const created = requests.find((request) => request.method === "session/new");
      assert.deepStrictEqual(created?.params?.mcpServers, [
        {
          name: "viewcode",
          command: "node",
          args: ["bridge.mjs", "--url", "x"],
          env: [{ name: "T", value: "1" }],
        },
      ]);
      assert.equal(
        requests.find((request) => request.method === "session/resume")?.params?.sessionId,
        "mock-session-1",
      );
      // The second session had no MCP session, so the user is told tools are missing.
      assert.equal(events.filter((event) => event.type === "runtime.warning").length, 1);
      assert.isTrue(events.every((event) => event.provider === ProviderDriverKind.make("droid")));
    }),
  );

  it.effect("answers a permission request with the option Droid offered for the decision", () =>
    Effect.gen(function* () {
      const { binaryPath, requestLogPath } = yield* Effect.promise(() =>
        makeMockDroid({
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "proceed_once",
          T3_ACP_ALLOW_ALWAYS_OPTION_ID: "proceed_always",
          T3_ACP_REJECT_ONCE_OPTION_ID: "cancel",
        }),
      );
      const adapter = yield* makeAdapter(binaryPath);
      const threadId = ThreadId.make("droid-permission");
      yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened" && event.requestId
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(event.requestId),
              "acceptForSession",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "run it" });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readRequests(requestLogPath));
      const outcomes = requests.flatMap((entry) => {
        const outcome = (entry as { result?: { outcome?: { optionId?: unknown } } }).result
          ?.outcome;
        return typeof outcome?.optionId === "string" ? [outcome.optionId] : [];
      });
      assert.deepStrictEqual(outcomes, ["proceed_always"]);
    }),
  );
});
