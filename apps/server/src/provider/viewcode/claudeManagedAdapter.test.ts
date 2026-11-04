import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
  EnvironmentId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  ClaudeManagedMcpConfigPaths,
  ClaudeManagedSettingsPaths,
} from "./claudeEnterprisePolicy.ts";
import { CLAUDE_TOOLS_OFF_NOTICE } from "./claudeManagedPolicy.ts";
import {
  makeClaudeAdapterV2,
  ClaudeAgentSdkQueryRunnerError,
  type ClaudeAgentSdkQueryOptions,
} from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";

const decodeSettings = Schema.decodeEffect(ClaudeSettings);
const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("managed-policy-test");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const runtimePolicy = {
  cwd: null,
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;
const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

const exercise = (firstFailure?: string, computer = false, runWithoutViewCodeTools = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const opened: Array<ClaudeAgentSdkQueryOptions> = [];
    const offered: Array<unknown> = [];
    const mcp = yield* McpProviderSessions.McpProviderSessions;
    yield* mcp.set({
      environmentId: EnvironmentId.make("env-test"),
      threadId,
      providerSessionId: "test",
      providerInstanceId: instanceId,
      endpoint: "http://localhost/mcp",
      authorizationHeader: "Bearer fake",
      reviewEndpoint: "http://localhost/reviews",
      reviewCliShimDir: "/tmp/review-shim",
      browserToolsAvailable: false,
      ...(computer
        ? {
            capabilities: new Set(["computer"]),
            agentDeviceEnvironment: {
              VIEWCODE_COMPUTER_CLI: "/tmp/viewcode/computer/bin/viewcode-computer",
            },
          }
        : {}),
    });
    const settings = yield* decodeSettings({
      enabled: true,
      launchArgs: "--permission-mode bypassPermissions --dangerously-skip-permissions",
      runWithoutViewCodeTools,
    });
    const adapter = yield* makeClaudeAdapterV2({
      instanceId,
      settings,
      environment: {},
      attachmentsDir: yield* fs.makeTempDirectoryScoped(),
      fileSystem: fs,
      path: yield* Path.Path,
      crypto: yield* Crypto.Crypto,
      idAllocator: yield* IdAllocator.IdAllocatorV2,
      queryRunner: {
        allocateSessionId: Effect.succeed("11111111-1111-4111-8111-111111111111"),
        open: (input) =>
          Effect.suspend(() => {
            opened.push(input.options);
            if (opened.length === 1 && firstFailure)
              return Effect.fail(
                new ClaudeAgentSdkQueryRunnerError({
                  method: "query",
                  cause: new Error(firstFailure),
                }),
              );
            return Effect.succeed({
              messages: Stream.never,
              offer: (message) =>
                Effect.sync(() => {
                  offered.push(message);
                }),
              setModel: () => Effect.void,
              applyFlagSettings: () => Effect.void,
              setPermissionMode: () => Effect.void,
              backgroundTasks: () => Effect.succeed(false),
              stopTask: () => Effect.void,
              interrupt: Effect.void,
              close: Effect.void,
            });
          }),
        forkSession: () => Effect.die("unused"),
        subagentLaunchToolUseId: () => Effect.succeed(null),
        assertComplete: Effect.void,
      },
    });
    const effectivePolicy = computer
      ? { ...runtimePolicy, runtimeMode: "approval-required" as const }
      : runtimePolicy;
    const runtime = yield* adapter.openSession({
      threadId,
      providerSessionId: ProviderSessionId.make("managed-session"),
      modelSelection,
      runtimePolicy: effectivePolicy,
    });
    const providerThread = yield* runtime.ensureThread({
      threadId,
      modelSelection,
      runtimePolicy: effectivePolicy,
    });
    const now = yield* DateTime.now;
    const appThread: OrchestrationV2AppThread = {
      id: threadId,
      projectId: ProjectId.make("managed-project"),
      createdBy: "user",
      creationSource: "web",
      title: "Managed",
      providerInstanceId: instanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: providerThread.id,
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
    const result = yield* runtime
      .startTurn({
        appThread,
        threadId,
        providerThread,
        modelSelection,
        runtimePolicy: effectivePolicy,
        runId: RunId.make("managed-run"),
        runOrdinal: 1,
        providerTurnOrdinal: 1,
        attemptId: RunAttemptId.make("managed-attempt"),
        rootNodeId: NodeId.make("managed-root"),
        message: {
          messageId: MessageId.make("managed-message"),
          text: "Reply OK",
          attachments: [],
          createdBy: "user",
          creationSource: "web",
        },
      })
      .pipe(Effect.result);
    return { opened, offered, result };
  });

describe("Claude v2 managed-machine launch", () => {
  it.effect(
    "omits client MCP under management and honors the administrator's bypass restriction",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const directory = yield* fs.makeTempDirectoryScoped();
        const mcp = path.join(directory, "managed-mcp.json");
        const settings = path.join(directory, "managed-settings.json");
        yield* fs.writeFileString(mcp, "{}");
        yield* fs.writeFileString(
          settings,
          '{"permissions":{"disableBypassPermissionsMode":"disable"}}',
        );
        const h = yield* exercise().pipe(
          Effect.provideService(ClaudeManagedMcpConfigPaths, [mcp]),
          Effect.provideService(ClaudeManagedSettingsPaths, [settings]),
        );
        assert.equal(h.result._tag, "Success");
        assert.lengthOf(h.opened, 1);
        assert.isUndefined(h.opened[0]?.mcpServers);
        assert.equal(h.opened[0]?.env?.VIEWCODE_REVIEW_ENDPOINT, "http://localhost/reviews");
        assert.equal(h.opened[0]?.permissionMode, "acceptEdits");
        assert.isUndefined(h.opened[0]?.allowDangerouslySkipPermissions);
        assert.isUndefined(h.opened[0]?.extraArgs?.["dangerously-skip-permissions"]);
        assert.lengthOf(h.offered, 1);
      }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("runs without ViewCode's MCP server when the user turned the tools off", () =>
    Effect.gen(function* () {
      const h = yield* exercise(undefined, false, true).pipe(
        Effect.provideService(ClaudeManagedMcpConfigPaths, []),
        Effect.provideService(ClaudeManagedSettingsPaths, []),
      );
      assert.equal(h.result._tag, "Success");
      assert.lengthOf(h.opened, 1);
      const options = h.opened[0];
      assert.isUndefined(options?.mcpServers);
      assert.isFalse(
        (options?.allowedTools ?? []).some((tool) => tool.startsWith("mcp__t3-code__")),
      );
      const prompt = options?.systemPrompt;
      assert.include(
        typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "preset"
          ? (prompt.append ?? "")
          : "",
        CLAUDE_TOOLS_OFF_NOTICE,
      );
      // The CLI shims stay reachable without MCP.
      assert.equal(options?.env?.VIEWCODE_REVIEW_ENDPOINT, "http://localhost/reviews");
      assert.lengthOf(h.offered, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("retries a specific startup refusal without MCP and offers the user message once", () =>
    Effect.gen(function* () {
      const h = yield* exercise(
        "You cannot dynamically configure MCP servers when an enterprise MCP config is present",
      ).pipe(
        Effect.provideService(ClaudeManagedMcpConfigPaths, []),
        Effect.provideService(ClaudeManagedSettingsPaths, []),
      );
      assert.equal(h.result._tag, "Success");
      assert.lengthOf(h.opened, 2);
      assert.isDefined(h.opened[0]?.mcpServers);
      assert.isUndefined(h.opened[1]?.mcpServers);
      assert.lengthOf(h.offered, 1);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});

it.effect(
  "allows only the trusted computer CLI through Claude's native prompt while ViewCode retains input approval",
  () =>
    Effect.gen(function* () {
      const h = yield* exercise(undefined, true).pipe(
        Effect.provideService(ClaudeManagedMcpConfigPaths, []),
        Effect.provideService(ClaudeManagedSettingsPaths, []),
      );
      const callback = h.opened[0]?.canUseTool;
      assert.isDefined(callback);
      if (!callback) return;
      const decision = yield* Effect.promise(() =>
        callback(
          "Bash",
          { command: "'/tmp/viewcode/computer/bin/viewcode-computer' list-windows" },
          {
            toolUseID: "computer-call",
            requestId: "computer-native-permission",
            signal: new AbortController().signal,
          },
        ),
      );
      assert.equal(decision?.behavior, "allow");
    }).pipe(Effect.scoped, Effect.provide(layer)),
);
