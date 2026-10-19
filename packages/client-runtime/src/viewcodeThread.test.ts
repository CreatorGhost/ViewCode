import { describe, expect, it } from "vite-plus/test";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  PlanId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { v2Now, v2Projection, v2ThreadShell } from "./state/orchestrationV2TestFixtures.ts";
import { derivePendingRequests } from "./pendingRequests.ts";
import { viewCodeThread, viewCodeThreadShell } from "./viewcodeThread.ts";

const runId = RunId.make("run:adapter");
const nodeId = NodeId.make("node:adapter");
const base = {
  threadId: v2Projection.thread.id,
  runId,
  nodeId,
  providerThreadId: null,
  providerTurnId: null,
  nativeItemRef: null,
  parentItemId: null,
  ordinal: 0,
  status: "completed",
  title: null,
  startedAt: v2Now,
  completedAt: v2Now,
  updatedAt: v2Now,
} as const;
const command: OrchestrationV2TurnItem = {
  ...base,
  id: TurnItemId.make("item:command"),
  type: "command_execution",
  input: "git status",
  output: "clean",
  exitCode: 0,
};
const plan: OrchestrationV2TurnItem = {
  ...base,
  id: TurnItemId.make("item:plan"),
  type: "proposed_plan",
  planId: PlanId.make("plan:adapter"),
  markdown: "Keep the original screens",
  streaming: false,
};
const approvalId = RuntimeRequestId.make("request:approval");
const questionId = RuntimeRequestId.make("request:question");
const approval: OrchestrationV2TurnItem = {
  ...base,
  status: "waiting",
  id: TurnItemId.make("item:approval"),
  type: "approval_request",
  requestId: approvalId,
  requestKind: "command",
  prompt: "Run the check?",
};
const question: OrchestrationV2TurnItem = {
  ...base,
  status: "waiting",
  id: TurnItemId.make("item:question"),
  type: "user_input_request",
  requestId: questionId,
  responseMode: "message",
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Which one?",
      options: [{ label: "Keep", description: "Preserve it", value: "keep" }],
    },
  ],
};
const items = [command, plan, approval, question];
const projection: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  messages: [
    {
      id: MessageId.make("message:adapter"),
      threadId: v2Projection.thread.id,
      runId,
      nodeId: null,
      role: "user",
      text: "Original request",
      attachments: [],
      streaming: false,
      createdAt: v2Now,
      updatedAt: v2Now,
      createdBy: "user",
      creationSource: "mobile",
    },
  ],
  turnItems: items,
  visibleTurnItems: items.map((item, position) => ({
    item,
    position,
    visibility: "local",
    sourceThreadId: item.threadId,
    sourceItemId: item.id,
  })),
  checkpoints: [
    {
      id: CheckpointId.make("checkpoint:adapter"),
      threadId: v2Projection.thread.id,
      scopeId: CheckpointScopeId.make("scope:adapter"),
      runId,
      nodeId,
      parentCheckpointId: null,
      ordinalWithinScope: 1,
      appRunOrdinal: 3,
      ref: CheckpointRef.make("refs/t3/checkpoint"),
      status: "ready",
      files: [{ path: "file.ts", kind: "modified", additions: 2, deletions: 1 }],
      capturedAt: v2Now,
    },
  ],
  runtimeRequests: [approvalId, questionId].map((id) => ({
    id,
    nodeId,
    providerTurnId: null,
    nativeRequestRef: null,
    kind: id === approvalId ? "command" : "user_input",
    status: "pending",
    responseCapability: { type: "message" },
    createdAt: v2Now,
    resolvedAt: null,
  })),
};

describe("ViewCode v2 presentation adapter", () => {
  it("keeps messages, tools, plans, checkpoints and native request correlation for the existing renderer", () => {
    const thread = viewCodeThread(projection);
    expect(thread.messages[0]?.text).toBe("Original request");
    expect(thread.messages[0]?.turnId).toBe(runId);
    expect(thread.proposedPlans[0]?.planMarkdown).toBe("Keep the original screens");
    expect(thread.checkpoints[0]).toMatchObject({
      turnId: runId,
      checkpointTurnCount: 3,
      files: [{ path: "file.ts", additions: 2, deletions: 1 }],
    });
    expect(thread.activities[0]).toMatchObject({
      kind: "tool.completed",
      payload: { toolCallId: command.id, command: "git status", output: "clean" },
    });
    const pending = derivePendingRequests(thread.activities);
    expect(pending.approvals[0]).toMatchObject({
      requestId: approvalId,
      requestKind: "command",
      detail: "Run the check?",
    });
    expect(pending.userInputs[0]).toMatchObject({
      requestId: questionId,
      dismissible: true,
      questions: [{ id: "choice" }],
    });
    const resolved = viewCodeThread({
      ...projection,
      runtimeRequests: projection.runtimeRequests.map((request) => ({
        ...request,
        status: "resolved",
      })),
    });
    expect(derivePendingRequests(resolved.activities)).toEqual({ approvals: [], userInputs: [] });
  });

  it("retains inherited conversation in visible order without duplicating local messages", () => {
    const inheritedUser: OrchestrationV2TurnItem = {
      ...base,
      threadId: ThreadId.make("parent"),
      id: TurnItemId.make("inherited-user"),
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: MessageId.make("z-user"),
      text: "Parent request",
      attachments: [],
    };
    const inheritedAssistant: OrchestrationV2TurnItem = {
      ...base,
      threadId: ThreadId.make("parent"),
      id: TurnItemId.make("inherited-assistant"),
      type: "assistant_message",
      messageId: MessageId.make("a-assistant"),
      text: "Parent answer",
      streaming: false,
    };
    const localUser: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("local-user"),
      type: "user_message",
      createdBy: "user",
      creationSource: "web",
      inputIntent: "turn_start",
      messageId: projection.messages[0]!.id,
      text: "Original request",
      attachments: [],
    };
    const thread = viewCodeThread({
      ...projection,
      visibleTurnItems: [inheritedUser, inheritedAssistant, localUser].map((item, position) => ({
        item,
        position,
        visibility: position < 2 ? "inherited" : "local",
        sourceThreadId: item.threadId,
        sourceItemId: item.id,
      })),
    });
    expect(thread.messages.map((message) => message.text)).toEqual([
      "Parent request",
      "Parent answer",
      "Original request",
    ]);
  });

  it("preserves ViewCode review and messaging activity payloads and separates the two goal features", () => {
    const activity = {
      id: EventId.make("activity:review"),
      turnId: null,
      kind: "viewcode.review.findings",
      tone: "info",
      summary: "Review complete",
      payload: { findings: ["one"] },
      createdAt: "2026-06-20T00:00:00.000Z",
    } as const;
    const notice: OrchestrationV2TurnItem = {
      ...base,
      id: TurnItemId.make("item:notice"),
      type: "system_notice",
      message: activity.summary,
      viewcodeActivity: activity,
    };
    const thread = viewCodeThread({
      ...projection,
      visibleTurnItems: [
        {
          item: notice,
          position: 0,
          visibility: "local",
          sourceThreadId: notice.threadId,
          sourceItemId: notice.id,
        },
      ],
    });
    expect(thread.activities).toEqual([activity]);
    const goal = {
      objective: "ViewCode objective",
      pausedAt: null,
      updatedAt: "2026-06-20T00:00:00.000Z",
    };
    const shell = viewCodeThreadShell({
      ...v2ThreadShell,
      parentThreadId: ThreadId.make("lead"),
      kind: "sidechat",
      viewcodeGoal: goal,
      debugMode: true,
      goal: { objective: "Native objective", status: "active" },
    });
    expect(shell).toMatchObject({
      parentThreadId: "lead",
      kind: "sidechat",
      goal,
      debugMode: true,
    });
  });
});
