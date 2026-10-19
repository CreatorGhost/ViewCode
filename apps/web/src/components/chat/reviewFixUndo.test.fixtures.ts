import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  CheckpointRef,
  CheckpointId,
  CheckpointScopeId,
  NodeId,
  RunId,
  type OrchestrationV2ThreadProjection,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
const threadRef = {
  environmentId: EnvironmentId.make("undo-environment"),
  threadId: ThreadId.make("undo-thread"),
};
const threadKey = scopedThreadKey(threadRef);
const otherThreadKey = scopedThreadKey({ ...threadRef, threadId: ThreadId.make("other-thread") });
const now = "2026-10-11T00:00:00.000Z";
const fixTurnId = TurnId.make("fix-turn");
const fixStarted = {
  id: EventId.make("fix-started"),
  kind: REVIEW_FIX_STARTED_ACTIVITY_KIND,
  tone: "info" as const,
  summary: "Review fix started",
  payload: { reviewThreadId: "review", turnCountBefore: 0, timelineBypass: true },
  turnId: null,
  createdAt: now,
};

const at = DateTime.makeUnsafe(now);
const runId = RunId.make(fixTurnId);
function makeThread(
  overrides: Partial<OrchestrationV2ThreadProjection> = {},
): OrchestrationV2ThreadProjection {
  const instanceId = ProviderInstanceId.make("codex");
  const messageId = MessageId.make("fix-message");
  return {
    thread: {
      id: threadRef.threadId,
      projectId: ProjectId.make("undo-project"),
      title: "Fix thread",
      providerInstanceId: instanceId,
      modelSelection: { instanceId, model: "gpt-6" },
      createdBy: "user",
      creationSource: "web",
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: "/workspace/worktrees/review-fix",
      activeProviderThreadId: null,
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: threadRef.threadId,
      },
      forkedFrom: null,
      historyOrigin: "native",
      createdAt: at,
      updatedAt: at,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [
      {
        id: runId,
        threadId: threadRef.threadId,
        ordinal: 1,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-6" },
        providerThreadId: null,
        userMessageId: messageId,
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: at,
        startedAt: at,
        completedAt: at,
        checkpointId: null,
        contextHandoffId: null,
      },
    ],
    messages: [
      {
        id: messageId,
        threadId: threadRef.threadId,
        role: "user",
        text: "Fix the findings",
        createdBy: "user",
        creationSource: "web",
        attachments: [],
        runId,
        nodeId: null,
        createdAt: at,
        updatedAt: at,
        streaming: false,
      },
    ],
    turnItems: [
      {
        id: importTurnItemId,
        threadId: threadRef.threadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        status: "completed",
        title: null,
        startedAt: at,
        completedAt: at,
        updatedAt: at,
        type: "system_notice",
        message: "Review fix started",
        viewcodeActivity: fixStarted,
      },
    ],
    checkpoints: [
      {
        id: CheckpointId.make("fix-checkpoint"),
        threadId: threadRef.threadId,
        scopeId: CheckpointScopeId.make("scope"),
        runId,
        nodeId: NodeId.make("fix-node"),
        parentCheckpointId: null,
        ordinalWithinScope: 1,
        appRunOrdinal: 1,
        ref: CheckpointRef.make("refs/viewcode/checkpoints/1"),
        status: "ready",
        files: [],
        capturedAt: at,
      },
    ],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    plans: [],
    checkpointScopes: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: at,
    ...overrides,
  };
}
const importTurnItemId = TurnItemId.make("fix-started");

export { threadRef, threadKey, otherThreadKey, makeThread, fixStarted };
