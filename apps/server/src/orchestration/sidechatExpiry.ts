import type { OrchestrationThreadShell } from "@t3tools/contracts";

/** A side chat idle this long is archived. Reopening the thread unarchives it. */
export const SIDECHAT_IDLE_EXPIRY_MS = 24 * 60 * 60 * 1_000;

type SidechatExpiryCandidate = Pick<
  OrchestrationThreadShell,
  "id" | "kind" | "archivedAt" | "updatedAt" | "latestUserMessageAt" | "session" | "latestTurn"
>;

/** Latest sign of life on the thread: its last update or the user's last message. */
function lastActivityMs(thread: SidechatExpiryCandidate): number {
  const stamps = [thread.updatedAt, thread.latestUserMessageAt]
    .filter((value): value is string => value != null)
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return stamps.length === 0 ? 0 : Math.max(...stamps);
}

/** Side chats that are not archived, not working, and idle for `expiryMs`. */
export function findExpiredSidechats<T extends SidechatExpiryCandidate>(
  threads: ReadonlyArray<T>,
  nowMs: number,
  expiryMs: number = SIDECHAT_IDLE_EXPIRY_MS,
): ReadonlyArray<T> {
  return threads.filter((thread) => {
    if (thread.kind !== "sidechat" || thread.archivedAt != null) return false;
    const status = thread.session?.status;
    if (status === "starting" || status === "running" || thread.latestTurn?.state === "running") {
      return false;
    }
    return nowMs - lastActivityMs(thread) >= expiryMs;
  });
}
