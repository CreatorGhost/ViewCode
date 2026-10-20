import type { OrchestrationV2RuntimeRequest } from "@t3tools/contracts";

/**
 * What a thread waits on the user for. This is the one "needs you" rule that web,
 * mobile, the server's MCP tools and RockBot share: only a pending approval or
 * question counts. Failures and finished plans are shown elsewhere, not here.
 */
export type ThreadNeed = "approval" | "question";

/**
 * What a pending runtime request asks of the user. The server answers dynamic tool
 * callbacks itself and an auth refresh goes through provider sign-in, so neither
 * waits in the thread (the thread's approval panel skips both too).
 */
export function runtimeRequestNeed(
  kind: OrchestrationV2RuntimeRequest["kind"] | null | undefined,
): ThreadNeed | null {
  if (kind == null || kind === "auth_refresh" || kind === "dynamic_tool_call") return null;
  return kind === "user_input" ? "question" : "approval";
}

interface ThreadNeedInput {
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: "approval" | "user_input" | null | undefined;
}

/** The thread's own wait. Count with this, so one blocked agent counts once. */
export function threadOwnNeed(thread: ThreadNeedInput): ThreadNeed | null {
  if (thread.hasPendingApprovals) return "approval";
  return thread.hasPendingUserInput ? "question" : null;
}

/**
 * A row's wait including a blocked child agent beneath it, for status shown on the
 * lead thread. An approval anywhere outranks a question.
 */
export function threadNeedWithAgents(thread: ThreadNeedInput): ThreadNeed | null {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "question";
  }
  return null;
}
