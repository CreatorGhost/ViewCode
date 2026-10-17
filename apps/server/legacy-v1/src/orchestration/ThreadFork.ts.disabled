import { MessageId, type OrchestrationMessage, type ThreadForkSource } from "@t3tools/contracts";

/**
 * ViewCode: fork a thread from one of its messages.
 *
 * A fork is an ordinary new thread in the same project whose history is a
 * copy of the source conversation up to (and including) the chosen message.
 * It never forks the provider's native session: the fork starts a fresh
 * session and its first turn carries the copied history as a handoff recap
 * (`ProviderCommandReactor`, the same path imported T3 Code threads use).
 *
 * The client only names the source. The server slices the history from its
 * own projection in `resolveThreadFork` (`ThreadForkResolver.ts`) (the decider's read model carries no
 * messages), so the decider can emit the thread, its history and the
 * "forked from" marker in one atomic command.
 */

/** Activity at the top of a fork; its payload links back to the source. */
export const THREAD_FORKED_ACTIVITY_KIND = "viewcode.thread.forked";

export type ThreadForkMessage = NonNullable<ThreadForkSource["messages"]>[number];

/**
 * The conversation a fork carries: user and assistant messages up to and
 * including `messageId`, with their text. Empty messages are skipped. Null when the message is not in the thread.
 */
export function sliceForkMessages(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "id" | "role" | "text" | "createdAt">>,
  messageId: string,
  forkThreadId: string,
): ReadonlyArray<ThreadForkMessage> | null {
  const end = messages.findIndex((message) => message.id === messageId);
  if (end < 0) return null;
  const carried: ThreadForkMessage[] = [];
  for (const message of messages.slice(0, end + 1)) {
    if (message.role !== "user" && message.role !== "assistant") continue;
    if (message.text.trim().length === 0) continue;
    carried.push({
      // Message ids are global; the fork needs its own copies.
      messageId: MessageId.make(`fork:${forkThreadId}:${message.id}`),
      role: message.role,
      text: message.text,
      createdAt: message.createdAt,
    });
  }
  return carried;
}

/** "Fork of <title>", without stacking prefixes on a fork of a fork. */
export function forkThreadTitle(sourceTitle: string): string {
  const base = sourceTitle.trim().replace(/^(Fork of )+/, "");
  return `Fork of ${base.length > 0 ? base : "thread"}`;
}

/** Opening line of the recap a fork's first turn carries. */
export function forkHandoffIntro(sourceTitle: string): string {
  return `This thread is a fork of "${sourceTitle}": it starts from a copy of that conversation up to the point the user forked it. Nothing after that point happened here, and changes made here do not affect the original thread.`;
}
