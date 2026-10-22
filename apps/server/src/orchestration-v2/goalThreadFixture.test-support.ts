import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Checkpoint,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const NOW = DateTime.makeUnsafe("2026-10-21T00:00:00.000Z");
export const GOAL_THREAD_ID = ThreadId.make("thread-goal");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("claude");

const prose = (label: string, bytes: number) =>
  `${label}: ${"The agent reports progress on the goal, with file names and test results. ".repeat(
    Math.ceil(bytes / 75),
  )}`.slice(0, bytes);

/**
 * A Claude goal thread after hours of work: one user turn, then a wake run every
 * few minutes (watchdog updates and agent handbacks start runs with a
 * notification), each with reasoning, tool calls, a reply and, now and then, a
 * spawned agent's handback report.
 */
export function makeGoalThreadProjection(input: {
  readonly wakeRuns: number;
}): OrchestrationV2ThreadProjection {
  const turnItems: OrchestrationV2TurnItem[] = [];
  const messages: OrchestrationV2ConversationMessage[] = [];
  const runs: OrchestrationV2Run[] = [];
  const checkpoints: OrchestrationV2Checkpoint[] = [];
  const addRun = (runId: RunId, userMessageId: MessageId) => {
    runs.push({
      id: runId,
      threadId: GOAL_THREAD_ID,
      ordinal: runs.length + 1,
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "claude-opus-4-1" },
      providerThreadId: null,
      userMessageId,
      rootNodeId: NodeId.make(`node-${runId}`),
      activeAttemptId: null,
      status: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      checkpointId: null,
      contextHandoffId: null,
    });
    // Control state is not paged: every run in the window carries its checkpoint file list.
    checkpoints.push({
      id: CheckpointId.make(`checkpoint-${runId}`),
      threadId: GOAL_THREAD_ID,
      scopeId: CheckpointScopeId.make("scope-goal"),
      runId,
      nodeId: NodeId.make(`node-${runId}`),
      parentCheckpointId: null,
      ordinalWithinScope: checkpoints.length,
      appRunOrdinal: runs.length,
      ref: CheckpointRef.make(`refs/viewcode/checkpoints/${runId}`),
      status: "ready",
      files: Array.from({ length: 12 }, (_, index) => ({
        path: `apps/server/src/orchestration-v2/feature/module-${index}.ts`,
        kind: "modified",
        additions: 4,
        deletions: 2,
      })),
      capturedAt: NOW,
    });
  };
  let ordinal = 0;
  const base = (id: string, runId: RunId) => ({
    id: TurnItemId.make(id),
    threadId: GOAL_THREAD_ID,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: ++ordinal,
    status: "completed" as const,
    title: null,
    startedAt: NOW,
    completedAt: NOW,
    updatedAt: NOW,
  });

  const goalRun = RunId.make("run-goal");
  addRun(goalRun, MessageId.make("message-goal"));
  turnItems.push({
    ...base("item-goal", goalRun),
    type: "user_message",
    messageId: MessageId.make("message-goal"),
    createdBy: "user",
    creationSource: "mobile",
    inputIntent: "turn_start",
    text: prose("Goal", 3_000),
    attachments: [],
  });

  for (let run = 0; run < input.wakeRuns; run += 1) {
    const runId = RunId.make(`run-${run}`);
    addRun(runId, MessageId.make(`message-${run}-wake`));
    turnItems.push({
      ...base(`item-${run}-wake`, runId),
      type: "notification",
      source: { kind: "subagent" },
      outcome: "updated",
      summary: `Watchdog update ${run}`,
      detail: prose("Watchdog", 1_500),
    });
    turnItems.push({
      ...base(`item-${run}-reasoning`, runId),
      type: "reasoning",
      text: prose("Thinking", 2_500),
      streaming: false,
    });
    for (let command = 0; command < 5; command += 1) {
      turnItems.push({
        ...base(`item-${run}-command-${command}`, runId),
        type: "command_execution",
        input: prose("bun run test", 400),
        output: prose("output", 16_000),
        exitCode: 0,
      });
    }
    if (run % 4 === 0) {
      turnItems.push({
        ...base(`item-${run}-agent`, runId),
        type: "subagent",
        subagentId: NodeId.make(`node-${run}-agent`),
        origin: "provider_native",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: PROVIDER_INSTANCE_ID,
        childThreadId: null,
        prompt: prose("Agent G brief", 3_000),
        progress: prose("Progress", 1_000),
        result: prose("Handback report", 24_000),
      });
    }
    const messageId = MessageId.make(`message-${run}`);
    const reply = prose("Reply", 2_000);
    turnItems.push({
      ...base(`item-${run}-reply`, runId),
      type: "assistant_message",
      messageId,
      text: reply,
      streaming: false,
    });
    messages.push({
      id: messageId,
      threadId: GOAL_THREAD_ID,
      runId,
      nodeId: null,
      role: "assistant",
      createdBy: "agent",
      creationSource: "mcp",
      text: reply,
      attachments: [],
      streaming: false,
      createdAt: NOW,
      updatedAt: NOW,
    });
  }

  const visibleTurnItems: OrchestrationV2ProjectedTurnItem[] = turnItems.map((item, position) => ({
    position,
    visibility: "local",
    sourceThreadId: GOAL_THREAD_ID,
    sourceItemId: item.id,
    item,
  }));

  return {
    thread: {
      id: GOAL_THREAD_ID,
      projectId: ProjectId.make("project-goal"),
      title: "Goal",
      providerInstanceId: PROVIDER_INSTANCE_ID,
      modelSelection: { instanceId: PROVIDER_INSTANCE_ID, model: "claude-opus-4-1" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: GOAL_THREAD_ID },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "mobile",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
    },
    runs,
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages,
    plans: [],
    turnItems,
    checkpointScopes: [],
    checkpoints,
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems,
    updatedAt: NOW,
  };
}
