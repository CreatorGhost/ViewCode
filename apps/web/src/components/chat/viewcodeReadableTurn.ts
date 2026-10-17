import type { OrchestrationLatestTurn } from "@t3tools/client-runtime/viewcodeThread";
import type { TurnId } from "@t3tools/contracts";
export function deriveUnsettledTurnId(
  latestTurn: OrchestrationLatestTurn | null,
  runningTurnId: TurnId | null,
): TurnId | null {
  if (runningTurnId !== null) return runningTurnId;
  if (!latestTurn) return null;
  return latestTurn.completedAt !== null && latestTurn.state !== "running"
    ? null
    : latestTurn.turnId;
}
