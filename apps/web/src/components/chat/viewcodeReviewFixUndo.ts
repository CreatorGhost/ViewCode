import { reviewFixUndo } from "@t3tools/client-runtime/review-findings";
import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";

/** Native projections can carry a notice in both the visible history and the current run. */
export function viewCodeReviewFixUndo(projection: OrchestrationV2ThreadProjection | null) {
  if (projection === null) return null;
  const activities = new Map(
    [...projection.turnItems, ...projection.visibleTurnItems.map((row) => row.item)].flatMap(
      (item) =>
        item.type === "system_notice" && item.viewcodeActivity !== undefined
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
