import type { OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

/**
 * Side chats: quick-question threads docked beside the thread they were opened
 * from. A side chat is an ordinary thread with `kind: "sidechat"` and
 * `parentThreadId`; these helpers keep the picking rules out of the components.
 */

type SidechatShell = Pick<
  OrchestrationThreadShell,
  "id" | "kind" | "parentThreadId" | "archivedAt" | "createdAt" | "updatedAt"
>;

export const SIDECHAT_TITLE = "Side chat";

/** Whether a thread is a side chat. Sidebars hide these and the dock owns them. */
export function isSidechat(thread: Pick<OrchestrationThreadShell, "kind">): boolean {
  return thread.kind === "sidechat";
}

/** A parent's live side chats, most recently touched first. */
export function sidechatsOf<T extends SidechatShell>(
  threads: ReadonlyArray<T>,
  parentThreadId: ThreadId,
): ReadonlyArray<T> {
  return threads
    .filter(
      (thread) =>
        isSidechat(thread) && thread.parentThreadId === parentThreadId && thread.archivedAt == null,
    )
    .toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The side chat the dock shows: the one the user last had open when it still
 * exists, otherwise the newest. Null means the dock starts a fresh one.
 */
export function resolveActiveSidechat<T extends SidechatShell>(
  sidechats: ReadonlyArray<T>,
  preferredId: ThreadId | null,
): T | null {
  return (
    (preferredId === null ? undefined : sidechats.find((thread) => thread.id === preferredId)) ??
    sidechats[0] ??
    null
  );
}

/** A side chat's tab label: the question it started with, trimmed to one line. */
export function sidechatLabel(firstUserMessage: string | null): string {
  const line = firstUserMessage?.trim().split("\n")[0]?.trim() ?? "";
  if (line.length === 0) return SIDECHAT_TITLE;
  return line.length > 48 ? `${line.slice(0, 47)}…` : line;
}

/** Title a new side chat takes from its first question. */
export function sidechatTitleFromQuestion(question: string): string {
  return sidechatLabel(question);
}
