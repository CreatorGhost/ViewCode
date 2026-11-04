import { rockBotChatsIn } from "@t3tools/client-runtime/state/rockbot";

interface RockBotChatCandidate {
  readonly environmentId: string;
  readonly id: string;
  readonly kind?: string | null | undefined;
  readonly archivedAt: string | null;
  readonly updatedAt: string;
}

/**
 * The RockBot chats of the open chat's environment, newest first, or null when the
 * open thread is not a RockBot chat. The sidebar shows these in place of the project tree.
 */
export function rockBotChatsForRoute<T extends RockBotChatCandidate>(
  threads: ReadonlyArray<T>,
  routeThread: { readonly environmentId: string; readonly threadId: string } | null,
): T[] | null {
  if (routeThread === null) return null;
  const open = threads.find(
    (thread) =>
      thread.environmentId === routeThread.environmentId && thread.id === routeThread.threadId,
  );
  if (open?.kind !== "orchestrator") return null;
  const chats = rockBotChatsIn(threads, open.environmentId);
  // The open chat stays listed while it is being archived, so the list never jumps.
  return open.archivedAt === null ? chats : [open, ...chats];
}
