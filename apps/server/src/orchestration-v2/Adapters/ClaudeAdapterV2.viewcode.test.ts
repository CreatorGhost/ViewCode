import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ClaudeSettings,
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
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  VIEWCODE_DIAGRAMS_GUIDANCE,
  VIEWCODE_DRAFTS_GUIDANCE,
} from "@t3tools/provider-core/server/runtimeInstructions";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { makeClaudeAdapterV2, type ClaudeAgentSdkQueryOptions } from "./ClaudeAdapterV2.ts";

// ViewCode guards for ClaudeAdapterV2, driven through the adapter itself so a merge that
// drops a call site fails here, not only one that drops a helper.

const instanceId = ProviderInstanceId.make("claudeAgent");
const threadId = ThreadId.make("viewcode-claude-guard");
const modelSelection = { instanceId, model: "claude-sonnet-4-6" };
const runtimePolicy = {
  cwd: null,
  runtimeMode: "full-access",
  interactionMode: "default",
} as const;
const NATIVE_SESSION = "11111111-1111-4111-8111-111111111111";
const decodeSettings = Schema.decodeEffect(ClaudeSettings);

type SubagentUpdated = Extract<
  ProviderAdapter.ProviderAdapterV2Event,
  { type: "subagent.updated" }
>;

const startClaudeTurn = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const opened: Array<ClaudeAgentSdkQueryOptions> = [];
  const frames = yield* Queue.unbounded<SDKMessage>();
  const adapter = yield* makeClaudeAdapterV2({
    instanceId,
    settings: yield* decodeSettings({ enabled: true }),
    environment: {},
    attachmentsDir: yield* fs.makeTempDirectoryScoped(),
    fileSystem: fs,
    path: yield* Path.Path,
    crypto: yield* Crypto.Crypto,
    idAllocator: yield* IdAllocator.IdAllocatorV2,
    queryRunner: {
      allocateSessionId: Effect.succeed(NATIVE_SESSION),
      open: (input) =>
        Effect.sync(() => {
          opened.push(input.options);
          return {
            messages: Stream.fromQueue(frames),
            offer: () => Effect.void,
            setModel: () => Effect.void,
            applyFlagSettings: () => Effect.void,
            setPermissionMode: () => Effect.void,
            backgroundTasks: () => Effect.succeed(false),
            stopTask: () => Effect.void,
            interrupt: Effect.void,
            close: Effect.void,
          };
        }),
      forkSession: () => Effect.die("unused"),
      subagentLaunchToolUseId: () => Effect.succeed(null),
      assertComplete: Effect.void,
    },
  });
  const runtime = yield* adapter.openSession({
    threadId,
    providerSessionId: ProviderSessionId.make("viewcode-guard-session"),
    modelSelection,
    runtimePolicy,
  });
  const providerThread = yield* runtime.ensureThread({ threadId, modelSelection, runtimePolicy });
  const subagentUpdates = yield* Queue.unbounded<SubagentUpdated>();
  yield* runtime.events.pipe(
    Stream.runForEach((event) =>
      event.type === "subagent.updated" ? Queue.offer(subagentUpdates, event) : Effect.void,
    ),
    Effect.forkScoped,
  );
  const now = yield* DateTime.now;
  const appThread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("viewcode-guard-project"),
    createdBy: "user",
    creationSource: "web",
    title: "Guard",
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
  yield* runtime.startTurn({
    appThread,
    threadId,
    providerThread,
    modelSelection,
    runtimePolicy,
    runId: RunId.make("viewcode-guard-run"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId: RunAttemptId.make("viewcode-guard-attempt"),
    rootNodeId: NodeId.make("viewcode-guard-root"),
    message: {
      messageId: MessageId.make("viewcode-guard-message"),
      text: "Review src/session.ts with a subagent.",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
  });
  /** The next subagent update that matches, skipping earlier ones. */
  const nextSubagentUpdate = (predicate: (event: SubagentUpdated) => boolean) =>
    Effect.gen(function* () {
      while (true) {
        const event = yield* Queue.take(subagentUpdates);
        if (predicate(event)) return event;
      }
    });
  return {
    opened,
    nextSubagentUpdate,
    offer: (frame: unknown) => Queue.offer(frames, frame as SDKMessage),
  };
});

const layer = Layer.mergeAll(NodeServices.layer, IdAllocator.layer, McpProviderSessions.layer);

describe("ClaudeAdapterV2 (ViewCode)", () => {
  // 60c02e083: every Claude session learns that a mermaid block renders inline and that a
  // quoted draft gets a copy button.
  it.effect("tells Claude about inline diagrams and copyable drafts", () =>
    Effect.gen(function* () {
      const claude = yield* startClaudeTurn;
      const prompt = claude.opened[0]?.systemPrompt;
      const append =
        typeof prompt === "object" && !Array.isArray(prompt) && prompt.type === "preset"
          ? (prompt.append ?? "")
          : "";
      assert.include(append, VIEWCODE_DIAGRAMS_GUIDANCE);
      assert.include(append, VIEWCODE_DRAFTS_GUIDANCE);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  // 0db3e6225: a subagent that ends with SubagentHandback leaves only a pointer in its
  // task_notification summary and Agent result; the report rides beside it as
  // handback_report / handbackReport. Recorded from Claude Code 2.1.304.
  const TASK_ID = "a0773bf1224f2c437";
  const TOOL_USE_ID = "toolu_01NbZWMG7qTD6K79xbXpQ2zT";
  const POINTER = `This agent's report was delivered to you as a message from "${TASK_ID}" (its SubagentHandback call). Read it there; it is not repeated here.\n`;
  const REPORT = "## Review of `src/session.ts`\n\nThe file is a four-line stub.";
  const taskStarted = {
    type: "system",
    subtype: "task_started",
    task_id: TASK_ID,
    tool_use_id: TOOL_USE_ID,
    description: "Review src/session.ts",
    subagent_type: "general-purpose",
    task_type: "local_agent",
    prompt: "Read src/session.ts and review it.",
    uuid: "00000000-0000-4000-8000-000000005001",
    session_id: NATIVE_SESSION,
  };
  const isCompleted = (event: SubagentUpdated) => event.subagent.status === "completed";

  it.effect("shows a handed-back subagent's report from its task notification", () =>
    Effect.gen(function* () {
      const claude = yield* startClaudeTurn;
      yield* claude.offer(taskStarted);
      yield* claude.offer({
        type: "system",
        subtype: "task_notification",
        task_id: TASK_ID,
        tool_use_id: TOOL_USE_ID,
        status: "completed",
        output_file: `/tmp/${TASK_ID}.output`,
        summary: POINTER,
        usage: { total_tokens: 32524, tool_uses: 4, duration_ms: 22598 },
        handback: "send",
        handback_report: { text: REPORT },
        uuid: "00000000-0000-4000-8000-000000005002",
        session_id: NATIVE_SESSION,
      });
      const completed = yield* claude.nextSubagentUpdate(isCompleted);
      assert.equal(completed.subagent.result, REPORT);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("shows a handed-back subagent's report from its Agent tool result", () =>
    Effect.gen(function* () {
      const claude = yield* startClaudeTurn;
      yield* claude.offer(taskStarted);
      yield* claude.offer({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: TOOL_USE_ID,
              content: [{ type: "text", text: `  ${POINTER}  \nagentId: ${TASK_ID}` }],
            },
          ],
        },
        parent_tool_use_id: null,
        tool_use_result: {
          status: "completed",
          prompt: "Read src/session.ts and review it.",
          agentId: TASK_ID,
          agentType: "general-purpose",
          handback: "send",
          handbackReport: { text: REPORT },
          content: [{ type: "text", text: POINTER }],
          totalDurationMs: 22600,
          canContinueAgent: true,
        },
        uuid: "00000000-0000-4000-8000-000000005003",
        session_id: NATIVE_SESSION,
      });
      const completed = yield* claude.nextSubagentUpdate(isCompleted);
      assert.equal(completed.subagent.result, REPORT);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
