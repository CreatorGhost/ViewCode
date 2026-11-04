import type { OrchestrationV2AppThread, OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export const SIDECHAT_IDLE_EXPIRY_MS = 24 * 60 * 60 * 1_000;
export const SIDECHAT_EXPIRY_SWEEP_MS = 10 * 60 * 1_000;

/** Active requests and queued work keep a side chat available until that work settles. */
export function findExpiredSidechats<T extends OrchestrationV2ThreadShell>(
  threads: ReadonlyArray<T>,
  nowMs: number,
): ReadonlyArray<T> {
  return threads.filter(
    (thread) =>
      thread.kind === "sidechat" &&
      thread.archivedAt === null &&
      thread.deletedAt === null &&
      thread.activeRunId === null &&
      thread.status === "idle" &&
      thread.pendingRuntimeRequest === null &&
      (thread.pendingBackgroundTasks?.length ?? 0) === 0 &&
      nowMs -
        Math.max(
          DateTime.toEpochMillis(thread.updatedAt),
          thread.latestUserMessageAt === null
            ? 0
            : DateTime.toEpochMillis(thread.latestUserMessageAt),
        ) >=
        SIDECHAT_IDLE_EXPIRY_MS,
  );
}

/** Evaluated while holding the native command lock, after the sweep's read. */
export function sidechatExpiryArchiveIsCurrent(input: {
  readonly thread: OrchestrationV2AppThread;
  readonly expectedUpdatedAt: DateTime.Utc;
  readonly runs: ReadonlyArray<{ readonly status: string }>;
  readonly runtimeRequests: ReadonlyArray<{ readonly status: string }>;
}): boolean {
  return (
    input.thread.kind === "sidechat" &&
    DateTime.toEpochMillis(input.thread.updatedAt) ===
      DateTime.toEpochMillis(input.expectedUpdatedAt) &&
    !input.runs.some((run) =>
      ["preparing", "queued", "starting", "running", "waiting"].includes(run.status),
    ) &&
    !input.runtimeRequests.some((request) => request.status === "pending")
  );
}
