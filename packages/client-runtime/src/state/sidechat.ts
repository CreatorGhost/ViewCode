import type { ModelSelection, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";

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

/**
 * The dock's remembered side chat: a thread id, `FRESH_SIDECHAT` after "New side
 * chat" (an empty composer until the next question creates one), or null when
 * nothing was picked yet.
 */
export const FRESH_SIDECHAT = "fresh";
export type SidechatPreference = ThreadId | typeof FRESH_SIDECHAT | null;

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
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

/**
 * The side chat the dock shows: none after "New side chat", else the one the
 * user last had open when it still exists, otherwise the newest. Null means the
 * dock starts a fresh one.
 */
export function resolveActiveSidechat<T extends SidechatShell>(
  sidechats: ReadonlyArray<T>,
  preferred: SidechatPreference,
): T | null {
  if (preferred === FRESH_SIDECHAT) return null;
  return (
    (preferred === null ? undefined : sidechats.find((thread) => thread.id === preferred)) ??
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

/** Creates a linked question thread in the parent's workspace; context comes from the server. */
export function buildSidechatCreateInput(input: {
  readonly parent: Pick<
    OrchestrationThreadShell,
    "id" | "projectId" | "modelSelection" | "runtimeMode" | "branch" | "worktreePath"
  >;
  readonly threadId: ThreadId;
  readonly question: string;
  readonly modelSelection?: ModelSelection;
}) {
  const { parent, threadId, question } = input;
  return {
    threadId,
    projectId: parent.projectId,
    title: sidechatTitleFromQuestion(question),
    modelSelection: input.modelSelection ?? parent.modelSelection,
    runtimeMode: parent.runtimeMode,
    interactionMode: "default" as const,
    branch: parent.branch,
    worktreePath: parent.worktreePath,
    parentThreadId: parent.id,
    kind: "sidechat" as const,
  };
}
