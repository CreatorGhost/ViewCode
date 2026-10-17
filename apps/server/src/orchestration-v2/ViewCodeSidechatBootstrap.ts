import type {
  OrchestrationV2AppThread,
  OrchestrationV2Command,
  OrchestrationV2ContextHandoff,
  OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as ProjectionStore from "./ProjectionStore.ts";

export const needsBootstrap = (thread: OrchestrationV2AppThread) =>
  thread.kind === "sidechat" &&
  thread.forkedFrom === null &&
  thread.lineage.parentThreadId !== null;

// A first-turn parent has no stable provider boundary to fork. Keep that rule intact and
// bootstrap only side chats as a new session, with a bounded snapshot on their first message.
export function plan(
  source: OrchestrationV2AppThread,
  command: Extract<OrchestrationV2Command, { readonly type: "thread.fork" }>,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  return {
    ...source,
    id: command.targetThreadId,
    title: command.title ?? "Side chat",
    createdBy: command.createdBy,
    creationSource: command.creationSource,
    kind: "sidechat",
    parentThreadId: source.id,
    lineage: {
      rootThreadId: source.lineage.rootThreadId,
      parentThreadId: source.id,
      relationshipToParent: "fork",
    },
    historyOrigin: "native",
    activeProviderThreadId: null,
    forkedFrom: null,
    viewcodeGoal: null,
    debugMode: false,
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledAt: null,
    settledOverride: null,
    snoozedUntil: null,
    snoozedAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

export const readItems = Effect.fn("ViewCodeSidechatBootstrap.readItems")(function* (
  thread: OrchestrationV2AppThread,
) {
  if (!needsBootstrap(thread) || thread.lineage.parentThreadId === null) return [];
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const snapshot = yield* projections.getThreadSnapshotWindow(thread.lineage.parentThreadId, {
    rowLimit: 60,
    userTurnLimit: 8,
  });
  const selected: OrchestrationV2TurnItem[] = [];
  let remaining = 24_000;
  for (const item of snapshot.projection.turnItems.toReversed()) {
    if (item.type !== "user_message" && item.type !== "assistant_message") continue;
    if (remaining <= 0) break;
    const text = item.text.slice(-Math.min(remaining, 8_000));
    remaining -= text.length;
    selected.unshift({ ...item, text });
  }
  return selected;
});

export const labelHandoff = (handoff: OrchestrationV2ContextHandoff) => ({
  ...handoff,
  summaryText: handoff.summaryText.replace(
    "Imported conversation history from the previous ViewCode orchestrator.",
    "Parent conversation snapshot for this side chat. The parent may still be working; its tools and unfinished work are not copied.",
  ),
});
