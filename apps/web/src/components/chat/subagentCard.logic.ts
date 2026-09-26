import {
  formatSubagentModelLabel,
  isActiveSubagentStatus,
  type RuntimeSubagent,
  type SubagentActivityEntry,
} from "@t3tools/client-runtime/state/subagentRuntime";

const STATUS_LABEL = {
  pending: "Starting",
  running: "Working",
  waiting: "Waiting",
  idle: "Idle",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
} satisfies Record<RuntimeSubagent["status"], string>;

function firstLine(value: string | null): string | null {
  return (
    value
      ?.split("\n")
      .find((line) => line.trim().length > 0)
      ?.trim() ?? null
  );
}

function timestamp(value: string | null): number | null {
  const parsed = value ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Usage and metadata updates are not evidence of new progress. */
export function subagentLastProgressAt(
  agent: Pick<RuntimeSubagent, "status" | "startedAt" | "firstSeenAt" | "recentActivity">,
): number | null {
  if (agent.status !== "pending" && agent.status !== "running") return null;
  let last = timestamp(agent.startedAt) ?? timestamp(agent.firstSeenAt);
  for (const entry of agent.recentActivity) {
    const at = firstLine(entry.summary) ? timestamp(entry.at) : null;
    if (at !== null) last = last === null ? at : Math.max(last, at);
  }
  return last;
}

export function subagentQuietMessage(lastProgressAt: number | null, now: number): string | null {
  if (lastProgressAt === null || !Number.isFinite(now)) return null;
  const minutes = Math.floor((now - lastProgressAt) / 60_000);
  return minutes >= 5
    ? `No progress update for ${minutes}m. The provider may still be working.`
    : null;
}

export function deriveSubagentElapsedMs(
  agent: Pick<
    RuntimeSubagent,
    "status" | "startedAt" | "firstSeenAt" | "completedAt" | "updatedAt"
  >,
  now: number,
): number | null {
  const isActive = isActiveSubagentStatus(agent.status);
  const start = timestamp(agent.startedAt) ?? timestamp(agent.firstSeenAt);
  // Idle is resumable, but it must not look like work is still in progress.
  const end = isActive ? now : (timestamp(agent.completedAt) ?? timestamp(agent.updatedAt));
  return start !== null && end !== null && Number.isFinite(end) ? Math.max(0, end - start) : null;
}

export function deriveSubagentCard(agent: RuntimeSubagent, now: number) {
  const history: SubagentActivityEntry[] = [];
  for (const entry of agent.recentActivity) {
    const summary = firstLine(entry.summary);
    if (summary && summary !== history.at(-1)?.summary) history.push({ at: entry.at, summary });
  }
  const fallback = firstLine(agent.progress) ?? firstLine(agent.lastToolName);
  if (history.length === 0 && fallback) history.push({ at: agent.updatedAt, summary: fallback });
  const occurrences = new Map<string, number>();
  // Count collisions from newest so dropping older history keeps retained keys stable.
  const keyedHistory = history
    .slice(-6)
    .toReversed()
    .map((entry) => {
      const key = JSON.stringify([entry.at, entry.summary]);
      const occurrence = occurrences.get(key) ?? 0;
      occurrences.set(key, occurrence + 1);
      return { ...entry, id: JSON.stringify([entry.at, entry.summary, occurrence]) };
    })
    .toReversed();
  const isActive = isActiveSubagentStatus(agent.status);
  const result = agent.result?.trim() || null;
  const error = agent.error?.trim() || null;
  const resultNotice =
    agent.status === "completed" && !result && !error
      ? "No separate task result was reported."
      : null;
  const outcome = isActive ? null : (firstLine(error) ?? firstLine(result) ?? resultNotice);

  return {
    statusLabel: STATUS_LABEL[agent.status],
    isActive,
    latestActivity: outcome ?? history.at(-1)?.summary ?? null,
    history: keyedHistory,
    result,
    resultNotice,
    error,
    modelLabel: formatSubagentModelLabel(agent.model, agent.effort),
    elapsedMs: deriveSubagentElapsedMs(agent, now),
  };
}
