import {
  EventId,
  MessageId,
  TurnId,
  type ChatAttachment,
  type CheckpointRef,
  type EnvironmentId,
  type ModelSelection,
  type OrchestrationMessageContext,
  type OrchestrationThreadActivity,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
  type OrchestrationV2RunStatus,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type ThreadGoal,
  type ThreadId,
  type ThreadKind,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { runtimeRequestNeed } from "@t3tools/shared/threadNeedsYou";
import * as DateTime from "effect/DateTime";

export interface OrchestrationMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system" | "reasoning";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly context?: OrchestrationMessageContext | undefined;
  readonly turnId: TurnId | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Copied from the thread this one was forked from: shown as history, never written here. */
  readonly inherited?: true;
  /** Speak mode's short spoken version of a turn's final reply, written by the server. */
  readonly spokenSummary?: string | undefined;
}

export interface OrchestrationLatestTurn {
  readonly turnId: TurnId;
  readonly state: "running" | "interrupted" | "completed" | "error";
  readonly requestedAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly sourceProposedPlan?: { readonly threadId: ThreadId; readonly planId: string };
}

export interface OrchestrationSession {
  readonly threadId: ThreadId;
  readonly status: "idle" | "starting" | "running" | "ready" | "interrupted" | "stopped" | "error";
  readonly providerName: string | null;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
  readonly activeTurnId: TurnId | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export interface OrchestrationProposedPlan {
  readonly id: string;
  readonly turnId: TurnId | null;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly implementationThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OrchestrationCheckpointSummary {
  readonly turnId: TurnId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error";
  readonly files: OrchestrationV2ThreadProjection["checkpoints"][number]["files"];
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export interface ViewCodeThreadShell {
  readonly id: ThreadId;
  readonly projectId: OrchestrationV2AppThread["projectId"];
  readonly title: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: OrchestrationV2AppThread["runtimeMode"];
  readonly interactionMode: OrchestrationV2AppThread["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly linkedPullRequest?: OrchestrationV2AppThread["linkedPullRequest"];
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly branchPullRequest?: OrchestrationV2AppThread["branchPullRequest"];
  readonly latestTurn: OrchestrationLatestTurn | null;
  readonly session: OrchestrationSession | null;
  readonly latestMessagePreview?: string;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly parentThreadId?: ThreadId | null;
  readonly kind?: ThreadKind | null;
  readonly goal?: ThreadGoal | null;
  readonly debugMode?: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly settledOverride: "settled" | "active" | null;
  readonly settledAt: string | null;
  readonly unsettledAt?: string | null;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly pinnedAt?: string | null;
  readonly pinOrderKey?: string | null;
  readonly activeOrderKey?: string | null;
  readonly autoSettleDisabledAt?: string | null;
  readonly titleRegeneration?: { readonly requestId: string; readonly startedAt: string } | null;
  readonly titleState?: {
    readonly source: "generated" | "manual";
    readonly version: string;
    readonly needsRefinement: boolean;
  } | null;
  readonly backgroundLiveness?: "working" | "monitoring" | null;
  /** Child threads this thread's provider session runs as subagents now (see the contract). */
  readonly runningSubagentThreadIds?: ReadonlyArray<ThreadId>;
  readonly planProgress?: {
    readonly step: string;
    readonly completedSteps: number;
    readonly totalSteps: number;
  } | null;
}

export interface ViewCodeThread extends ViewCodeThreadShell {
  readonly deletedAt: string | null;
  readonly messages: ReadonlyArray<OrchestrationMessage>;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly proposedPlans: ReadonlyArray<OrchestrationProposedPlan>;
  readonly checkpoints: ReadonlyArray<OrchestrationCheckpointSummary>;
}

// These names belong to the existing ViewCode renderers, never to the wire protocol.
export type OrchestrationThread = ViewCodeThread;
export type OrchestrationThreadShell = ViewCodeThreadShell;
export interface EnvironmentThread extends ViewCodeThread {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
}
export interface EnvironmentThreadShell extends ViewCodeThreadShell {
  readonly environmentId: EnvironmentId;
  readonly source?: OrchestrationV2ThreadShell;
}

const iso = DateTime.formatIso;
const nullableIso = (value: DateTime.Utc | null | undefined) => (value == null ? null : iso(value));
const turnId = (value: string | null) => (value === null ? null : TurnId.make(value));

function turnState(status: OrchestrationV2RunStatus): OrchestrationLatestTurn["state"] {
  switch (status) {
    case "failed":
      return "error";
    case "interrupted":
    case "cancelled":
      return "interrupted";
    case "completed":
    case "rolled_back":
      return "completed";
    default:
      return "running";
  }
}

function sessionStatus(
  status: OrchestrationV2ThreadShell["status"],
): OrchestrationSession["status"] {
  switch (status) {
    case "idle":
      return "idle";
    case "queued":
    case "preparing":
    case "starting":
      return "starting";
    case "waiting":
    case "running":
      return "running";
    case "completed":
    case "rolled_back":
      return "ready";
    case "interrupted":
      return "interrupted";
    case "cancelled":
      return "stopped";
    case "failed":
      return "error";
  }
}

export function viewCodeThreadShell(thread: OrchestrationV2ThreadShell): ViewCodeThreadShell {
  const last = thread.latestRunId;
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    linkedPullRequest: thread.linkedPullRequest,
    pullRequests: thread.pullRequests ?? [],
    branchPullRequest: thread.branchPullRequest,
    latestTurn:
      last === null
        ? null
        : {
            turnId: TurnId.make(last),
            state: turnState(thread.status === "idle" ? "completed" : thread.status),
            requestedAt: nullableIso(thread.latestRunRequestedAt) ?? iso(thread.createdAt),
            startedAt: nullableIso(thread.latestRunStartedAt),
            completedAt: nullableIso(thread.latestRunCompletedAt),
            assistantMessageId: null,
          },
    session:
      last === null && thread.activeProviderThreadId === null
        ? null
        : {
            threadId: thread.id,
            status: sessionStatus(thread.activityRunStatus ?? thread.status),
            providerName: null,
            providerInstanceId: thread.providerInstanceId,
            runtimeMode: thread.runtimeMode,
            activeTurnId: turnId(thread.activeRunId),
            lastError: thread.lastError ?? null,
            updatedAt: iso(thread.updatedAt),
          },
    ...(thread.latestVisibleMessage?.text
      ? { latestMessagePreview: thread.latestVisibleMessage.text }
      : {}),
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    hasPendingApprovals: runtimeRequestNeed(thread.pendingRuntimeRequest?.kind) === "approval",
    hasPendingUserInput: runtimeRequestNeed(thread.pendingRuntimeRequest?.kind) === "question",
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    parentThreadId: thread.parentThreadId ?? thread.lineage.parentThreadId,
    kind: thread.kind ?? null,
    goal: thread.viewcodeGoal ?? null,
    debugMode: thread.debugMode ?? false,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    archivedAt: nullableIso(thread.archivedAt),
    settledOverride: thread.settledOverride,
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt),
    snoozedUntil: nullableIso(thread.snoozedUntil),
    snoozedAt: nullableIso(thread.snoozedAt),
    pinnedAt: nullableIso(thread.pinnedAt),
    pinOrderKey: thread.pinOrderKey ?? null,
    activeOrderKey: thread.activeOrderKey ?? null,
    autoSettleDisabledAt: nullableIso(thread.autoSettleDisabledAt),
    titleRegeneration:
      thread.titleRegeneration == null
        ? null
        : {
            requestId: thread.titleRegeneration.requestId,
            startedAt: iso(thread.titleRegeneration.startedAt),
          },
    backgroundLiveness: (thread.pendingBackgroundTasks ?? []).some(
      (task) => task.kind !== "monitor",
    )
      ? "working"
      : (thread.pendingBackgroundTasks ?? []).length > 0
        ? "monitoring"
        : null,
    runningSubagentThreadIds: thread.runningSubagentThreadIds ?? [],
  };
}

export function scopeThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): EnvironmentThreadShell {
  return { ...viewCodeThreadShell(thread), environmentId, source: thread };
}

function messageFor(message: OrchestrationV2ConversationMessage): OrchestrationMessage {
  return {
    ...message,
    turnId: turnId(message.runId),
    createdAt: iso(message.createdAt),
    updatedAt: iso(message.updatedAt),
  };
}

function activityFor(
  item: OrchestrationV2TurnItem,
  pendingRequestIds: ReadonlySet<string>,
): OrchestrationThreadActivity | null {
  if (item.type === "system_notice" && item.viewcodeActivity !== undefined)
    return item.viewcodeActivity;
  if (
    ["user_message", "assistant_message", "reasoning", "proposed_plan", "checkpoint"].includes(
      item.type,
    )
  )
    return null;
  const base = {
    id: EventId.make(`viewcode:item:${item.id}`),
    turnId: turnId(item.runId),
    createdAt: iso(item.startedAt ?? item.updatedAt),
  };
  const status = item.status;
  const pending = status === "pending" || status === "running" || status === "waiting";
  switch (item.type) {
    case "approval_request":
      return {
        ...base,
        tone: "approval",
        kind: pendingRequestIds.has(item.requestId) ? "approval.requested" : "approval.resolved",
        summary: item.prompt || "Approval requested",
        payload: {
          ...item,
          requestId: item.requestId,
          status,
          ...(item.prompt ? { detail: item.prompt } : {}),
        },
      };
    case "user_input_request":
      return {
        ...base,
        tone: "approval",
        kind: pendingRequestIds.has(item.requestId)
          ? "user-input.requested"
          : "user-input.resolved",
        summary: item.title || "Input requested",
        payload: { ...item, requestId: item.requestId, status },
      };
    case "error":
      return {
        ...base,
        tone: "error",
        kind: "provider.error",
        summary: item.failure.message,
        payload: item.failure,
      };
    case "system_notice":
      return {
        ...base,
        tone: "info",
        kind: "runtime.notice",
        summary: item.message || "Notice",
        payload: item,
      };
    case "notification":
      return {
        ...base,
        tone: "info",
        kind: "runtime.notice",
        summary: item.summary,
        payload: item,
      };
    default:
      return {
        ...base,
        tone: "tool",
        // A call in flight is an update of a running call, not a start notice: mobile's work log
        // drops start notices (v1 sent one before every call's updates), which hid every running
        // call, and every working agent, until it finished.
        kind: pending ? "tool.updated" : "tool.completed",
        summary: item.title || item.type.replaceAll("_", " "),
        payload: {
          ...item,
          toolCallId: item.id,
          toolName: item.type === "dynamic_tool" ? item.toolName : item.type,
          itemType: item.type === "dynamic_tool" ? "mcp_tool_call" : item.type,
          title: item.title ?? item.type.replaceAll("_", " "),
          ...(item.type === "command_execution" && item.output ? { detail: item.output } : {}),
          data: {
            ...item,
            ...(item.type === "command_execution" ? { command: item.input } : {}),
            ...(item.type === "file_change"
              ? {
                  files: [
                    { path: item.fileName, additions: item.additions, deletions: item.deletions },
                  ],
                }
              : {}),
          },
          status,
          ...(item.type === "command_execution"
            ? { command: item.input, output: item.output }
            : {}),
          ...(item.type === "file_change"
            ? {
                files: [
                  { path: item.fileName, additions: item.additions, deletions: item.deletions },
                ],
              }
            : {}),
        },
      };
  }
}

function latestTurnFor(
  run: OrchestrationV2Run | undefined,
  projection: OrchestrationV2ThreadProjection,
): OrchestrationLatestTurn | null {
  if (run === undefined) return null;
  return {
    turnId: TurnId.make(run.id),
    state: turnState(run.status),
    requestedAt: iso(run.requestedAt),
    startedAt: nullableIso(run.startedAt),
    completedAt: nullableIso(run.completedAt),
    assistantMessageId:
      projection.messages.findLast(
        (message) => message.runId === run.id && message.role === "assistant",
      )?.id ?? null,
  };
}

export function viewCodeThread(projection: OrchestrationV2ThreadProjection): ViewCodeThread {
  const thread = projection.thread;
  const items = projection.visibleTurnItems.map(({ item }) => item);
  const inherited = (row: OrchestrationV2ThreadProjection["visibleTurnItems"][number]) =>
    row.visibility === "local" ? {} : { inherited: true as const };
  const latestRun = [...projection.runs].sort((left, right) => left.ordinal - right.ordinal).at(-1);
  const pendingRequests = projection.runtimeRequests.filter(
    (request) => request.status === "pending",
  );
  const latestTurn = latestTurnFor(latestRun, projection);
  const pendingRequestIds = new Set(pendingRequests.map((request) => request.id));
  const nativeMessageIds = new Set(projection.messages.map((message) => message.id));
  const inheritedMessages = projection.visibleTurnItems.flatMap((row): OrchestrationMessage[] => {
    const { item } = row;
    if (
      (item.type !== "user_message" && item.type !== "assistant_message") ||
      nativeMessageIds.has(item.messageId)
    )
      return [];
    return [
      {
        ...inherited(row),
        id: item.messageId,
        role: item.type === "user_message" ? "user" : "assistant",
        text: item.text,
        attachments: item.attachments ?? [],
        ...(item.type === "user_message" && item.context !== undefined
          ? { context: item.context }
          : {}),
        turnId: turnId(item.runId),
        streaming: item.type === "assistant_message" && item.streaming,
        createdAt: iso(item.startedAt ?? item.updatedAt),
        updatedAt: iso(item.updatedAt),
      },
    ];
  });
  const visibleMessagePositions = new Map(
    items.flatMap((item, position): [string, number][] =>
      item.type === "user_message" || item.type === "assistant_message"
        ? [[item.messageId, position]]
        : item.type === "reasoning"
          ? [[`viewcode:reasoning:${item.id}`, position]]
          : [],
    ),
  );
  const messages = [
    ...projection.messages.map(messageFor),
    ...inheritedMessages,
    ...projection.visibleTurnItems.flatMap((row): OrchestrationMessage[] => {
      const { item } = row;
      return item.type !== "reasoning"
        ? []
        : [
            {
              ...inherited(row),
              id: MessageId.make(`viewcode:reasoning:${item.id}`),
              role: "reasoning",
              text: item.text,
              turnId: turnId(item.runId),
              streaming: item.streaming,
              createdAt: iso(item.startedAt ?? item.updatedAt),
              updatedAt: iso(item.updatedAt),
            },
          ];
    }),
  ].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      (visibleMessagePositions.get(left.id) ?? Number.MAX_SAFE_INTEGER) -
        (visibleMessagePositions.get(right.id) ?? Number.MAX_SAFE_INTEGER),
  );
  return {
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    linkedPullRequest: thread.linkedPullRequest,
    pullRequests: thread.pullRequests ?? [],
    branchPullRequest: thread.branchPullRequest,
    latestTurn,
    session:
      latestRun === undefined && projection.providerSessions.length === 0
        ? null
        : {
            threadId: thread.id,
            status: sessionStatus(latestRun?.status ?? "idle"),
            providerName: projection.providerSessions.at(-1)?.driver ?? null,
            providerInstanceId: thread.providerInstanceId,
            runtimeMode: thread.runtimeMode,
            activeTurnId: latestTurn?.state === "running" ? latestTurn.turnId : null,
            lastError: projection.providerSessions.at(-1)?.lastError ?? null,
            updatedAt: iso(thread.updatedAt),
          },
    latestUserMessageAt: messages.findLast((message) => message.role === "user")?.createdAt ?? null,
    hasPendingApprovals: pendingRequests.some(
      (request) => runtimeRequestNeed(request.kind) === "approval",
    ),
    hasPendingUserInput: pendingRequests.some(
      (request) => runtimeRequestNeed(request.kind) === "question",
    ),
    hasActionableProposedPlan: projection.plans.some(
      (plan) =>
        plan.kind === "proposed_plan" && (plan.status === "active" || plan.status === "draft"),
    ),
    parentThreadId: thread.parentThreadId ?? thread.lineage.parentThreadId,
    kind: thread.kind ?? null,
    goal: thread.viewcodeGoal ?? null,
    debugMode: thread.debugMode ?? false,
    createdAt: iso(thread.createdAt),
    updatedAt: iso(thread.updatedAt),
    archivedAt: nullableIso(thread.archivedAt),
    settledOverride: thread.settledOverride,
    settledAt: nullableIso(thread.settledAt),
    unsettledAt: nullableIso(thread.unsettledAt),
    snoozedUntil: nullableIso(thread.snoozedUntil),
    snoozedAt: nullableIso(thread.snoozedAt),
    pinnedAt: nullableIso(thread.pinnedAt),
    pinOrderKey: thread.pinOrderKey ?? null,
    activeOrderKey: thread.activeOrderKey ?? null,
    autoSettleDisabledAt: nullableIso(thread.autoSettleDisabledAt),
    deletedAt: nullableIso(thread.deletedAt),
    titleRegeneration:
      thread.titleRegeneration == null
        ? null
        : {
            requestId: thread.titleRegeneration.requestId,
            startedAt: iso(thread.titleRegeneration.startedAt),
          },
    messages,
    activities: items
      .map((item) => activityFor(item, pendingRequestIds))
      .filter((activity): activity is OrchestrationThreadActivity => activity !== null),
    proposedPlans: items.flatMap((item) =>
      item.type !== "proposed_plan"
        ? []
        : [
            {
              id: item.planId,
              turnId: turnId(item.runId),
              planMarkdown: item.markdown,
              implementedAt: null,
              implementationThreadId: null,
              createdAt: iso(item.startedAt ?? item.updatedAt),
              updatedAt: iso(item.updatedAt),
            },
          ],
    ),
    checkpoints: projection.checkpoints.flatMap((checkpoint) =>
      checkpoint.runId === null || checkpoint.appRunOrdinal === null
        ? []
        : [
            {
              turnId: TurnId.make(checkpoint.runId),
              checkpointTurnCount: checkpoint.appRunOrdinal,
              checkpointRef: checkpoint.ref,
              status: checkpoint.status === "stale" ? "missing" : checkpoint.status,
              files: checkpoint.files,
              assistantMessageId:
                projection.messages.findLast(
                  (message) => message.role === "assistant" && message.runId === checkpoint.runId,
                )?.id ?? null,
              completedAt: iso(checkpoint.capturedAt),
            },
          ],
    ),
  };
}

export function scopeThread(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentThread {
  return { ...viewCodeThread(projection), environmentId, projection };
}

export function formatSubagentModelLabel(
  model: string | null,
  effort: string | null,
): string | null {
  if (!model) return null;
  const compact = model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
  return effort ? `${compact} · ${effort}` : compact;
}
