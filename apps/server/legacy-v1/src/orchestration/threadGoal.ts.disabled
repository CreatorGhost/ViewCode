import type { ThreadGoal } from "@t3tools/contracts";

/**
 * The goal a `thread.meta.update` leaves on the thread, or undefined when the
 * command does not touch it. A new objective keeps the current pause unless the
 * command says otherwise, so editing a paused goal does not resume it.
 */
export function nextThreadGoal(
  current: ThreadGoal | null,
  command: {
    readonly goal?: string | null | undefined;
    readonly goalPaused?: boolean | undefined;
  },
  occurredAt: string,
): ThreadGoal | null | undefined {
  if (command.goal === null) return null;
  const objective = command.goal ?? current?.objective;
  if (objective === undefined) return undefined;
  if (command.goal === undefined && command.goalPaused === undefined) return undefined;
  const pausedAt =
    command.goalPaused === undefined
      ? (current?.pausedAt ?? null)
      : command.goalPaused
        ? (current?.pausedAt ?? occurredAt)
        : null;
  if (current !== null && current.objective === objective && current.pausedAt === pausedAt) {
    return undefined;
  }
  return { objective, pausedAt, updatedAt: occurredAt };
}
