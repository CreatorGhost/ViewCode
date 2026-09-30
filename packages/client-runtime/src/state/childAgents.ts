import type {
  AgentControlState,
  EnvironmentId,
  OrchestrationThreadShell,
  ThreadId,
} from "@t3tools/contracts";

/**
 * ViewCode child agents (threads whose `parentThreadId` chain leads to a lead
 * thread) and what the user can do to them. Shared by the web Active agents
 * bar and the mobile Home list and thread screen.
 */

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
  const status = thread.session?.status;
  return status === "starting" || status === "running" || thread.latestTurn?.state === "running";
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

export interface AgentControlAvailability {
  /** Interrupt and pause it (`agents.stop`). */
  readonly stop: boolean;
  /** Continue a paused agent and deliver what it holds (`agents.resume`). */
  readonly resume: boolean;
  /** Drop the held messages and replies, which also unpauses it (`agents.discard`). */
  readonly discard: boolean;
}

/**
 * Which agent-control actions one agent offers, as the web Active agents bar
 * decides: Stop while it runs and is not already paused, Resume while paused
 * (the way back from Stop), Discard while anything is held for it.
 */
export function resolveAgentControlAvailability(input: {
  readonly running: boolean;
  readonly control: Pick<AgentControlState, "paused" | "queued"> | undefined;
}): AgentControlAvailability {
  const paused = input.control?.paused === true;
  const queued = input.control?.queued ?? 0;
  return {
    stop: input.running && !paused,
    resume: paused,
    discard: paused || queued > 0,
  };
}

export interface AgentTreeControlSummary {
  /** Running agents in the tree, the lead included. */
  readonly running: number;
  readonly paused: number;
  /** Agent messages and replies waiting across the tree. */
  readonly queued: number;
}

/**
 * Counts a tree's running, paused and queued agents for tree-wide controls.
 * `key` is whatever `control` is keyed by (a thread id, or a scoped key).
 */
export function summarizeAgentTreeControl(
  agents: ReadonlyArray<{ readonly running: boolean; readonly key: string }>,
  control: ReadonlyMap<string, Pick<AgentControlState, "paused" | "queued">>,
): AgentTreeControlSummary {
  let running = 0;
  let paused = 0;
  let queued = 0;
  for (const agent of agents) {
    const state = control.get(agent.key);
    if (agent.running) running += 1;
    if (state?.paused) paused += 1;
    queued += state?.queued ?? 0;
  }
  return { running, paused, queued };
}
