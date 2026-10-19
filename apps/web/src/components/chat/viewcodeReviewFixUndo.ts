import { reviewFixUndo } from "@t3tools/client-runtime/review-findings";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** Deduplicate native notices; inherited fork history does not transfer ownership of a fix. */
export function viewCodeReviewFixUndo(projection: OrchestrationV2ThreadProjection | null) {
  if (projection === null) return null;
  const activities = new Map(
    [
      ...projection.turnItems,
      ...projection.visibleTurnItems
        .filter(
          (row) => row.sourceThreadId === projection.thread.id && row.visibility !== "inherited",
        )
        .map((row) => row.item),
    ].flatMap((item) =>
      item.threadId === projection.thread.id &&
      item.type === "system_notice" &&
      item.viewcodeActivity !== undefined
        ? [[item.viewcodeActivity.id, item.viewcodeActivity] as const]
        : [],
    ),
  );
  return reviewFixUndo({
    activities: [...activities.values()].toSorted((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    ),
    checkpoints: projection.runs
      .filter((run) => run.status !== "rolled_back")
      .map((run) => ({ checkpointTurnCount: run.ordinal })),
  });
}

/** Known unsafe workspaces can be explained before submitting; native admission remains authoritative. */
export function viewCodeReviewFixUndoUnavailableReason(
  projection: OrchestrationV2ThreadProjection | null,
  otherThreads: ReadonlyArray<{
    readonly id: string;
    readonly worktreePath: string | null;
    readonly deletedAt?: unknown;
  }> = [],
): string | null {
  if (projection === null) return null;
  const thread = projection.thread;
  if (thread.worktreePath === null) {
    return "Undo review fixes requires an exclusive worktree. This session uses a root checkout. Review and revert its changes manually with Git.";
  }
  if (
    otherThreads.some(
      (other) =>
        other.id !== thread.id &&
        other.deletedAt == null &&
        other.worktreePath === thread.worktreePath,
    )
  ) {
    return "Undo review fixes requires an exclusive worktree. Another thread uses this worktree, including idle or archived threads. Review and revert its changes manually with Git.";
  }
  return null;
}
