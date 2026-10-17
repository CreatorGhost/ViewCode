import {
  MessageId,
  TurnItemId,
  type ContextTransferId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type OrchestrationV2ContextTransfer,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { ThreadForkPlanError, isForkableSourceRunStatus } from "./ThreadForkService.ts";

export const hasRunlessConversationPrefix = (thread: OrchestrationV2AppThread) =>
  thread.historyOrigin === "v1_import" || thread.viewcodeMessageFork !== undefined;

// Native forks include an entire provider turn. An exact user-message fork instead
// owns an immutable conversation prefix, so neither paging nor a later handoff can
// accidentally read the source's reply or subsequent edits.
export const plan = (input: {
  source: OrchestrationV2ThreadProjection;
  command: Extract<OrchestrationV2Command, { type: "thread.fork" }>;
  transferId: ContextTransferId;
  boundaryRun?: OrchestrationV2Run;
  runlessBoundary?: boolean;
  now: DateTime.Utc;
}) =>
  Effect.gen(function* () {
    const { source, command, now } = input;
    const fail = (cause: string) =>
      new ThreadForkPlanError({
        sourceThreadId: source.thread.id,
        targetThreadId: command.targetThreadId,
        cause,
      });
    const rows = source.visibleTurnItems;
    const boundary = rows.findIndex(
      (row) =>
        (row.item.type === "user_message" || row.item.type === "assistant_message") &&
        row.item.messageId === command.sourceMessageId,
    );
    if (boundary < 0) return yield* fail("Fork source message was not found in this thread.");
    const selected = rows[boundary]!.item;
    if (selected.type !== "user_message")
      return yield* fail("Only a user message can be an exact fork boundary.");
    const sourceRun = source.runs.find((run) => run.id === selected.runId) ?? input.boundaryRun;
    if (
      selected.runId !== null &&
      (sourceRun === undefined || !isForkableSourceRunStatus(sourceRun.status))
    ) {
      return yield* fail(
        "The selected user message belongs to an in-progress, rolled-back, or unavailable run.",
      );
    }
    if (
      selected.runId === null &&
      !hasRunlessConversationPrefix(source.thread) &&
      input.runlessBoundary !== true
    ) {
      return yield* fail(
        "A runless user message must belong to imported or previously forked conversation history.",
      );
    }
    const provenance = {
      sourceThreadId: source.thread.id,
      messageId: selected.messageId,
      turnItemId: selected.id,
    };
    const targetThread: OrchestrationV2AppThread = {
      ...source.thread,
      id: command.targetThreadId,
      title: command.title ?? `${source.thread.title} fork`,
      createdBy: command.createdBy,
      creationSource: command.creationSource,
      parentThreadId: source.thread.id,
      ...(command.kind === undefined ? {} : { kind: command.kind }),
      viewcodeMessageFork: provenance,
      lineage: {
        parentThreadId: source.thread.id,
        relationshipToParent: "fork",
        rootThreadId: source.thread.lineage.rootThreadId,
      },
      forkedFrom: null,
      activeProviderThreadId: null,
      pullRequests: [],
      linkedPullRequest: null,
      branchPullRequest: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      deletedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedAt: null,
      snoozedUntil: null,
      lastVisitedAt: null,
    };
    const transfer: OrchestrationV2ContextTransfer = {
      id: input.transferId,
      type: "fork",
      sourceThreadId: source.thread.id,
      targetThreadId: command.targetThreadId,
      sourcePoint: {
        threadId: source.thread.id,
        messageId: selected.messageId,
        turnItemId: selected.id,
        ...(selected.runId === null ? {} : { runId: selected.runId }),
      },
      basePoint: null,
      sourceProviderInstanceId: sourceRun?.providerInstanceId ?? source.thread.providerInstanceId,
      targetProviderInstanceId: null,
      targetRunId: null,
      status: "pending",
      resolution: null,
      createdBy: command.createdBy,
      error: null,
      createdAt: now,
      updatedAt: now,
      consumedAt: null,
    };
    const items: OrchestrationV2TurnItem[] = [];
    const messages: OrchestrationV2ConversationMessage[] = [];
    for (const row of rows.slice(0, boundary + 1)) {
      const original = row.item;
      if (original.type !== "user_message" && original.type !== "assistant_message") continue;
      const messageId = MessageId.make(`fork:${command.targetThreadId}:${original.messageId}`);
      const base = {
        ...original,
        id: TurnItemId.make(`fork:${command.targetThreadId}:${original.id}`),
        threadId: command.targetThreadId,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        messageId,
        ordinal: items.length + 1,
        status: "completed" as const,
      };
      const item: OrchestrationV2TurnItem =
        base.type === "assistant_message" ? { ...base, streaming: false } : base;
      items.push(item);
      messages.push({
        id: messageId,
        threadId: command.targetThreadId,
        runId: null,
        nodeId: null,
        createdBy: original.type === "user_message" ? original.createdBy : "agent",
        creationSource: original.type === "user_message" ? original.creationSource : "provider",
        role: original.type === "user_message" ? "user" : "assistant",
        text: original.text,
        attachments: original.attachments ?? [],
        streaming: false,
        ...(original.type === "user_message" && original.context !== undefined
          ? { context: original.context }
          : {}),
        createdAt: original.startedAt ?? original.updatedAt,
        updatedAt: original.updatedAt,
      });
    }
    return { targetThread, transfer, items, messages };
  });
