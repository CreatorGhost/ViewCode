/**
 * The state a turn settles in once its end-of-turn checkpoint lands.
 *
 * A checkpoint records the workspace, not the turn's outcome. A turn the
 * provider rejected still gets a checkpoint, so the outcome the session
 * already recorded (interrupted or failed) must win over the checkpoint's own
 * status. Before this, only "interrupted" was kept and a failed turn was
 * stored as "completed", indistinguishable from a successful one.
 *
 * Exhaustive on purpose, with no default branch: a new turn state must be
 * mapped explicitly rather than fall through to "completed".
 *
 * Shared by the server's SQL projection, its in-memory projector and the
 * client reducer, which must agree.
 */
export function turnStateAfterCheckpoint(
  existing: "pending" | "running" | "completed" | "interrupted" | "error" | null | undefined,
  checkpointStatus: "ready" | "missing" | "error",
): "completed" | "interrupted" | "error" {
  switch (existing) {
    case "interrupted":
      return "interrupted";
    case "error":
      return "error";
    case "pending":
    case "running":
    case "completed":
    case null:
    case undefined:
      return checkpointStatusToTurnState(checkpointStatus);
  }
}

/** A checkpoint's own status as a turn state. A missing git ref is not a failure. */
export function checkpointStatusToTurnState(
  status: "ready" | "missing" | "error",
): "completed" | "error" {
  switch (status) {
    case "error":
      return "error";
    case "ready":
    case "missing":
      return "completed";
  }
}
