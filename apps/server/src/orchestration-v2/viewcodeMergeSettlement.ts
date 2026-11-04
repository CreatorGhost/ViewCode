/**
 * ViewCode: a merged pull request hands the thread back to its agent instead of settling it.
 *
 * Upstream settles a thread as soon as its pull request merges after the user's last message. A
 * merge is often one step of a larger task (deploy, re-run, verify), and the agent's own next
 * steps waited for it, so the thread settled with half the task open. Now the agent gets one
 * message when the merge lands, and the thread settles only once a run has finished after the
 * merge, with nothing still running. A merge older than the wake window settles as before, so a
 * server update never wakes old threads at once. See docs/internals/viewcode.md "Sidebar".
 */

const HOUR_MS = 60 * 60 * 1000;

/** A merge newer than this wakes the agent; an older one settles as upstream did. */
export const MERGE_WAKE_WINDOW_MS = 6 * HOUR_MS;

export type MergeSettlementStep = "settle" | "wake-agent";

export function mergeSettlementStep(input: {
  readonly mergedAtMs: number;
  readonly latestRunCompletedAtMs: number | null;
  readonly nowMs: number;
}): MergeSettlementStep {
  // The agent already had a turn that ended after the merge, such as the turn that merged it.
  if (input.latestRunCompletedAtMs !== null && input.latestRunCompletedAtMs >= input.mergedAtMs) {
    return "settle";
  }
  return input.nowMs - input.mergedAtMs <= MERGE_WAKE_WINDOW_MS ? "wake-agent" : "settle";
}

export function mergeWakeMessage(pullRequestNumber: number | null): string {
  const pullRequest =
    pullRequestNumber === null ? "This thread's pull request" : `#${pullRequestNumber}`;
  return `${pullRequest} merged. If any part of this task is still left (a deploy, a re-run, a check that waited for the merge), carry on with it now. If nothing is left, reply in one line that the task is done.`;
}
