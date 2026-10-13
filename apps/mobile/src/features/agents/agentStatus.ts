/** What a child agent row's dot shows. `paused` is a user Stop (agent control). */
export type HomeAgentStatus = "needs-you" | "working" | "paused" | "failed" | "stopped" | "idle";

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

/**
 * The Active agents bar's muted summary: what the tree is doing ("2 working · 1 paused"),
 * or how many agents sit idle when nothing runs, is held or waits.
 */
export function activeAgentsSummaryText(
  summary: { readonly running: number; readonly paused: number; readonly queued: number },
  agentCount: number,
): string {
  const parts = [
    summary.running > 0 ? `${summary.running} working` : null,
    summary.paused > 0 ? `${summary.paused} paused` : null,
    summary.queued > 0 ? `${summary.queued} queued` : null,
  ].filter((part) => part !== null);
  return parts.length > 0 ? parts.join(" · ") : `${agentCount} idle`;
}
