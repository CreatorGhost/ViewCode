// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import type {
  Options as ClaudeQueryOptions,
  PermissionMode,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  ClaudeSettings,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { SYNTHETIC_CLAUDE_MODEL_CATALOG } from "../ClaudeModelCatalog.testFixtures.ts";
import { ClaudeManagedMcpConfigPaths } from "../Drivers/ClaudeEnterprisePolicy.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ClaudeAdapterShape } from "../Services/ClaudeAdapter.ts";
import { makeClaudeAdapter } from "./ClaudeAdapter.ts";

const decodeClaudeSettings = Schema.decodeSync(ClaudeSettings);

const ENTERPRISE_STDERR =
  "You cannot dynamically configure MCP servers when an enterprise MCP config is present";
const THREAD_ID = ThreadId.make("thread-claude-managed");
const SECOND_THREAD_ID = ThreadId.make("thread-claude-managed-2");
const missingPolicy = NodePath.join(NodeOS.tmpdir(), "t3-no-such-dir", "managed-mcp.json");

const presentPolicy = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-claude-policy-"));
  const file = NodePath.join(dir, "managed-mcp.json");
  NodeFS.writeFileSync(file, "{}");
  return file;
};

/**
 * A Claude CLI stand-in: a message stream that can fail like the SDK does
 * when the process exits, and control requests that, when deferred, stay
 * pending until that exit and then reject as the SDK's do.
 */
class FakeClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<{
    readonly resolve: (value: IteratorResult<SDKMessage>) => void;
    readonly reject: (reason: unknown) => void;
  }> = [];
  private readonly pendingControl: Array<(reason: unknown) => void> = [];
  private done = false;
  private failure: unknown | undefined;
  public deferControlRequests = false;

  emit(message: SDKMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ done: false, value: message });
    else this.queue.push(message);
  }

  fail(cause: unknown): void {
    if (this.done) return;
    this.done = true;
    this.failure = cause;
    for (const waiter of this.waiters.splice(0)) waiter.reject(cause);
    for (const reject of this.pendingControl.splice(0)) {
      reject(new Error("Query closed before response received"));
    }
  }

  readonly setModel = async (_model?: string): Promise<void> => {};
  readonly setPermissionMode = async (_mode: PermissionMode): Promise<void> => {
    if (!this.deferControlRequests) return;
    return new Promise<void>((_resolve, reject) => {
      this.pendingControl.push(reject);
    });
  };
  readonly setMaxThinkingTokens = async (_tokens: number | null): Promise<void> => {};
  readonly close = (): void => {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) waiter.resolve({ done: true, value: undefined });
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const value = this.queue.shift();
        if (value) return Promise.resolve({ done: false, value });
        if (this.failure !== undefined) {
          const failure = this.failure;
          this.failure = undefined;
          return Promise.reject(failure);
        }
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
      },
    };
  }
}

const issueMcpSession = (threadId: ThreadId) => {
  const config: McpProviderSession.McpProviderSessionConfig = {
    environmentId: EnvironmentId.make("env-claude-managed"),
    threadId,
    providerSessionId: `mcp-${threadId}`,
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    endpoint: "http://127.0.0.1:1/mcp",
    authorizationHeader: "Bearer test-token",
    capabilities: new Set(["pull-requests", "agents"]),
  };
  McpProviderSession.setMcpProviderSession(config);
  return config;
};

const clearMcpSessions = Effect.sync(() => {
  McpProviderSession.clearMcpProviderSession(THREAD_ID);
  McpProviderSession.clearMcpProviderSession(SECOND_THREAD_ID);
});

function makeHarness(claudeConfig?: Partial<ClaudeSettings>) {
  const queries: Array<FakeClaudeQuery> = [];
  const createInputs: Array<{
    readonly prompt: AsyncIterable<SDKUserMessage>;
    readonly options: ClaudeQueryOptions;
  }> = [];
  /** Runs `body` against a fresh adapter whose managed-MCP file check sees `policyPaths`. */
  const run = <A, E>(
    policyPaths: ReadonlyArray<string>,
    body: (adapter: ClaudeAdapterShape) => Effect.Effect<A, E, Scope.Scope>,
  ) =>
    Effect.gen(function* () {
      const adapter = yield* makeClaudeAdapter(decodeClaudeSettings(claudeConfig ?? {}), {
        modelCatalog: Effect.succeed(SYNTHETIC_CLAUDE_MODEL_CATALOG),
        createQuery: (input) => {
          const query = new FakeClaudeQuery();
          queries.push(query);
          createInputs.push(input);
          return query;
        },
      });
      return yield* body(adapter);
    }).pipe(
      Effect.scoped,
      Effect.ensuring(clearMcpSessions),
      Effect.provideService(ClaudeManagedMcpConfigPaths, policyPaths),
      Effect.provide(
        Layer.mergeAll(
          ServerConfig.layerTest("/tmp/claude-adapter-test", "/tmp"),
          ServerSettingsService.layerTest(),
        ).pipe(Layer.provideMerge(NodeServices.layer)),
      ),
    );
  return { queries, createInputs, run };
}

/** Records every runtime event; `waitFor` resolves once a matching one has arrived. */
const recordEvents = (adapter: ClaudeAdapterShape) =>
  Effect.gen(function* () {
    const events: Array<ProviderRuntimeEvent> = [];
    const waiters: Array<{
      readonly matches: (event: ProviderRuntimeEvent) => boolean;
      readonly done: Deferred.Deferred<ProviderRuntimeEvent>;
    }> = [];
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.gen(function* () {
        events.push(event);
        for (const waiter of waiters.filter((entry) => entry.matches(event))) {
          waiters.splice(waiters.indexOf(waiter), 1);
          yield* Deferred.succeed(waiter.done, event);
        }
      }),
    ).pipe(Effect.forkScoped);
    const waitFor = (matches: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        const seen = events.find(matches);
        if (seen) return seen;
        const done = yield* Deferred.make<ProviderRuntimeEvent>();
        waiters.push({ matches, done });
        return yield* Deferred.await(done);
      });
    return { events, waitFor };
  });

const isToolsWarning = (event: ProviderRuntimeEvent) =>
  event.type === "runtime.warning" &&
  (event.payload.detail as { viewcodeTools?: string } | undefined)?.viewcodeTools === "unavailable";

const warningReason = (event: ProviderRuntimeEvent) =>
  event.type === "runtime.warning"
    ? (event.payload.detail as { reason?: string } | undefined)?.reason
    : undefined;

const startSession = (adapter: ClaudeAdapterShape, threadId: ThreadId) =>
  adapter.startSession({
    threadId,
    provider: ProviderDriverKind.make("claudeAgent"),
    runtimeMode: "full-access",
  });

const appendedInstructions = (options: ClaudeQueryOptions | undefined) =>
  (options?.systemPrompt as { append?: string } | undefined)?.append ?? "";

const resultMessage = (uuid: string) =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    errors: [],
    session_id: "sdk-session-managed",
    uuid,
  }) as unknown as SDKMessage;

describe("ClaudeAdapter with an enterprise-managed MCP config", () => {
  it.effect(
    "relaunches without ViewCode tools when Claude refuses them and resends the turn",
    () => {
      const harness = makeHarness();
      const mcp = issueMcpSession(THREAD_ID);
      issueMcpSession(SECOND_THREAD_ID);
      return harness.run([missingPolicy], (adapter) =>
        Effect.gen(function* () {
          const recorder = yield* recordEvents(adapter);
          yield* startSession(adapter, THREAD_ID);
          assert.deepEqual(harness.createInputs[0]?.options.mcpServers, {
            [McpProviderSession.MCP_SERVER_NAME]: McpProviderSession.claudeMcpServerConfig(mcp),
          });

          const turn = yield* adapter.sendTurn({
            threadId: THREAD_ID,
            input: "hello",
            attachments: [],
          });
          harness.queries[0]!.fail(
            new Error(`Claude Code process exited with code 1. stderr: ${ENTERPRISE_STDERR}\n`),
          );

          const warning = yield* recorder.waitFor(isToolsWarning);
          assert.equal(warningReason(warning), "managed-mcp");
          if (warning.type === "runtime.warning") {
            assert.include(warning.payload.message, "Your organization manages Claude Code's MCP");
          }
          assert.equal(harness.queries.length, 2);
          const retry = harness.createInputs[1]!;
          assert.equal(retry.options.mcpServers, undefined);
          assert.equal(retry.options.strictMcpConfig, undefined);
          assert.include(appendedInstructions(retry.options), "<viewcode_tools>");
          assert.notInclude(appendedInstructions(retry.options), "<viewcode_agents>");
          assert.notInclude(appendedInstructions(retry.options), "<pull_request_linking>");

          // The same turn reaches the relaunched CLI.
          const resent = yield* Effect.promise(() => retry.prompt[Symbol.asyncIterator]().next());
          assert.equal(resent.value?.uuid, String(turn.turnId));

          harness.queries[1]!.emit({
            type: "assistant",
            session_id: "sdk-session-managed",
            uuid: "assistant-managed-1",
            parent_tool_use_id: null,
            message: { id: "assistant-message-managed", content: [{ type: "text", text: "Hi" }] },
          } as unknown as SDKMessage);
          harness.queries[1]!.emit(resultMessage("result-managed-1"));
          const completed = yield* recorder.waitFor((event) => event.type === "turn.completed");
          assert.equal(String(completed.turnId), String(turn.turnId));
          if (completed.type === "turn.completed") {
            assert.equal(completed.payload.state, "completed");
          }
          assert.isTrue(
            recorder.events.some(
              (event) =>
                event.type === "item.completed" && String(event.turnId) === String(turn.turnId),
            ),
          );
          assert.isFalse(recorder.events.some((event) => event.type === "runtime.error"));
          assert.isTrue(yield* adapter.hasSession(THREAD_ID));

          // Later sessions on this instance (child agents included) skip MCP at once.
          yield* startSession(adapter, SECOND_THREAD_ID);
          assert.equal(harness.createInputs.length, 3);
          assert.equal(harness.createInputs[2]?.options.mcpServers, undefined);
          const second = yield* recorder.waitFor(
            (event) => isToolsWarning(event) && event.threadId === SECOND_THREAD_ID,
          );
          assert.equal(warningReason(second), "managed-mcp");
        }),
      );
    },
  );

  it.effect("starts without ViewCode tools when the managed MCP file is present", () => {
    const harness = makeHarness();
    issueMcpSession(THREAD_ID);
    return harness.run([presentPolicy()], (adapter) =>
      Effect.gen(function* () {
        const recorder = yield* recordEvents(adapter);
        yield* startSession(adapter, THREAD_ID);
        assert.equal(harness.createInputs.length, 1);
        assert.equal(harness.createInputs[0]?.options.mcpServers, undefined);
        assert.equal(
          appendedInstructions(harness.createInputs[0]?.options),
          buildRuntimeInstructions({
            harness: "Claude Code",
            viewcodeToolsUnavailable: "managed-mcp",
          }),
        );
        assert.equal(warningReason(yield* recorder.waitFor(isToolsWarning)), "managed-mcp");
      }),
    );
  });

  it.effect("passes ViewCode's MCP server exactly as before on an unmanaged machine", () => {
    const harness = makeHarness();
    const mcp = issueMcpSession(THREAD_ID);
    return harness.run([missingPolicy], (adapter) =>
      Effect.gen(function* () {
        const recorder = yield* recordEvents(adapter);
        yield* startSession(adapter, THREAD_ID);
        const turn = yield* adapter.sendTurn({
          threadId: THREAD_ID,
          input: "hello",
          attachments: [],
        });
        harness.queries[0]!.emit(resultMessage(`result-${turn.turnId}`));
        yield* recorder.waitFor((event) => event.type === "turn.completed");

        const options = harness.createInputs[0]!.options;
        assert.deepEqual(options.mcpServers, {
          [McpProviderSession.MCP_SERVER_NAME]: McpProviderSession.claudeMcpServerConfig(mcp),
        });
        assert.equal(
          appendedInstructions(options),
          buildRuntimeInstructions({ harness: "Claude Code" }),
        );
        assert.equal(harness.createInputs.length, 1);
        assert.isFalse(recorder.events.some((event) => event.type === "runtime.warning"));
      }),
    );
  });

  it.effect("runs without ViewCode tools when the setting asks for it", () => {
    const harness = makeHarness({ runWithoutViewCodeTools: true });
    issueMcpSession(THREAD_ID);
    return harness.run([missingPolicy], (adapter) =>
      Effect.gen(function* () {
        const recorder = yield* recordEvents(adapter);
        yield* startSession(adapter, THREAD_ID);
        assert.equal(harness.createInputs[0]?.options.mcpServers, undefined);
        assert.include(
          appendedInstructions(harness.createInputs[0]?.options),
          "turned them off in ViewCode's settings",
        );
        const warning = yield* recorder.waitFor(isToolsWarning);
        assert.equal(warningReason(warning), "setting");
        if (warning.type === "runtime.warning") {
          assert.include(warning.payload.message, "turned off for Claude in Settings");
        }
      }),
    );
  });

  it.effect("reports a dead CLI as its exit and stderr, not as the request that reached it", () => {
    const harness = makeHarness();
    return harness.run([missingPolicy], (adapter) =>
      Effect.gen(function* () {
        const recorder = yield* recordEvents(adapter);
        yield* startSession(adapter, THREAD_ID);
        harness.queries[0]!.deferControlRequests = true;
        const sendFiber = yield* adapter
          .sendTurn({
            threadId: THREAD_ID,
            input: "hello",
            attachments: [],
            interactionMode: "default",
          })
          .pipe(Effect.flip, Effect.forkScoped);
        yield* Effect.yieldNow;
        harness.queries[0]!.fail(
          new Error("Claude Code process exited with code 1. stderr: Error: config is broken\n"),
        );

        const error = yield* Fiber.join(sendFiber);
        assert.equal(error._tag, "ProviderAdapterProcessError");
        if (error._tag === "ProviderAdapterProcessError") {
          assert.equal(error.detail, "Claude Code exited (code 1): Error: config is broken");
        }
        assert.notInclude(error.message, "setPermissionMode");
        const runtimeError = yield* recorder.waitFor((event) => event.type === "runtime.error");
        if (runtimeError.type === "runtime.error") {
          assert.equal(
            runtimeError.payload.message,
            "Claude Code exited (code 1): Error: config is broken",
          );
        }
      }),
    );
  });
});
