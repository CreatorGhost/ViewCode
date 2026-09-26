import type { EnvironmentId, OrchestrationThreadShell, ThreadId } from "@t3tools/contracts";
import { isThreadSessionRunning } from "@t3tools/client-runtime/state/threads";

type ChildAgentShellInput = Pick<
  OrchestrationThreadShell,
  "id" | "parentThreadId" | "archivedAt" | "session" | "latestTurn"
> & { readonly environmentId: EnvironmentId };

export interface ChildAgentEntry<T extends ChildAgentShellInput> {
  readonly thread: T;
  /** 1 for direct children, 2 for grandchildren, … */
  readonly depth: number;
  readonly running: boolean;
}

/** A child agent counts as running while its session or latest turn is in flight. */
export function isChildAgentRunning(
  thread: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
): boolean {
  return isThreadSessionRunning(thread.session) || thread.latestTurn?.state === "running";
}

/**
 * Every non-archived descendant of `rootThreadId` in the same environment,
 * depth-first in input order so a child's own children follow it. Cycles in
 * `parentThreadId` (never expected, but data is data) are cut at the first
 * revisit.
 */
export function collectChildAgents<T extends ChildAgentShellInput>(
  threads: ReadonlyArray<T>,
  root: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): ReadonlyArray<ChildAgentEntry<T>> {
  const childrenByParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    if (thread.environmentId !== root.environmentId) continue;
    if (thread.archivedAt != null || thread.parentThreadId == null) continue;
    const siblings = childrenByParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else childrenByParent.set(thread.parentThreadId, [thread]);
  }
  if (childrenByParent.size === 0) return [];

  const result: ChildAgentEntry<T>[] = [];
  const visited = new Set<ThreadId>([root.threadId]);
  const visit = (parentId: ThreadId, depth: number) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      result.push({ thread: child, depth, running: isChildAgentRunning(child) });
      visit(child.id, depth + 1);
    }
  };
  visit(root.threadId, 1);
  return result;
}

/**
 * The whole agent tree `ref` belongs to: its root (depth 0) and every
 * descendant. A thread without parent or children is a tree of one.
 */
export function collectAgentTree<T extends ChildAgentShellInput>(
  threads: ReadonlyArray<T>,
  ref: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): ReadonlyArray<ChildAgentEntry<T>> {
  const byId = new Map<ThreadId, T>();
  for (const thread of threads) {
    if (thread.environmentId === ref.environmentId) byId.set(thread.id, thread);
  }
  let root = byId.get(ref.threadId);
  const seen = new Set<ThreadId>();
  while (root?.parentThreadId && byId.has(root.parentThreadId) && !seen.has(root.id)) {
    seen.add(root.id);
    root = byId.get(root.parentThreadId);
  }
  if (!root) return [];
  return [
    { thread: root, depth: 0, running: isChildAgentRunning(root) },
    ...collectChildAgents(threads, { environmentId: ref.environmentId, threadId: root.id }),
  ];
}

export type ChildAgentStatus = "approval" | "input" | "working" | "failed" | "idle";

/** What a child agent row shows: anything asking for the user outranks working. */
export function resolveChildAgentStatus(
  thread: Pick<
    OrchestrationThreadShell,
    "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
  >,
): ChildAgentStatus {
  if (thread.hasPendingApprovals) return "approval";
  if (thread.hasPendingUserInput) return "input";
  if (isChildAgentRunning(thread)) return "working";
  if (thread.session?.status === "error") return "failed";
  return "idle";
}

export function countRunningChildAgents(
  agents: ReadonlyArray<{ readonly running: boolean }>,
): number {
  let count = 0;
  for (const agent of agents) if (agent.running) count += 1;
  return count;
}
