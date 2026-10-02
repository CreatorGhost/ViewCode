import type { HomeAgentStatus } from "../home/homeFolderList";

/**
 * One label and dot per agent status, shared by Home's agent rows and the
 * thread screen's agents panel so the same agent never reads differently.
 * Idle (session alive) is a solid neutral dot, stopped (no session) a hollow
 * ring, so the two stay apart without relying on colour.
 */
export const AGENT_STATUS = {
  "needs-you": { label: "Needs you", dotClass: "bg-adaptive-amber-700-400" },
  working: { label: "Working", dotClass: "bg-adaptive-sky-600-400" },
  paused: { label: "Paused", dotClass: "bg-adaptive-amber-700-400" },
  failed: { label: "Failed", dotClass: "bg-adaptive-rose-600-400" },
  idle: { label: "Idle", dotClass: "bg-foreground-muted" },
  stopped: { label: "Stopped", dotClass: "border border-foreground-muted" },
} as const satisfies Record<HomeAgentStatus, { label: string; dotClass: string }>;

const STATUS_ORDER: ReadonlyArray<HomeAgentStatus> = [
  "working",
  "needs-you",
  "paused",
  "failed",
  "idle",
  "stopped",
];

/** Lower sorts first: working agents, then the ones that need a decision, stopped last. */
export function agentStatusRank(status: HomeAgentStatus): number {
  return STATUS_ORDER.indexOf(status);
}

/** Stable sort by `rankOf`, ascending. */
export function sortAgentsByStatus<T>(agents: ReadonlyArray<T>, rankOf: (agent: T) => number): T[] {
  return (
    agents
      .map((agent, index) => ({ agent, index, rank: rankOf(agent) }))
      // .sort() on the mapped copy: Hermes doesn't ship .toSorted().
      .sort((a, b) => a.rank - b.rank || a.index - b.index)
      .map((entry) => entry.agent)
  );
}
