import { formatAgentElapsed } from "@t3tools/client-runtime/state/child-agents";
import {
  formatSubagentDisplayTitle,
  spawnedAgentsHeading,
  subagentDetailPreview,
  subagentRowIsActive,
  subagentRowState,
  subagentRowStateLabel,
  summarizeSubagentRowStates,
  type SubagentRowState,
} from "@t3tools/client-runtime/state/subagent-display";
import type { AgentControlState, OrchestrationV2Subagent, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import type { SubagentTurnItem } from "../../lib/threadActivity";

/** One spawned agent: its turn item, what its lead's projection says now, and agent control. */
export interface SpawnedAgentInput {
  readonly item: SubagentTurnItem;
  readonly live: OrchestrationV2Subagent | null | undefined;
  readonly control: Pick<AgentControlState, "paused" | "queued"> | undefined;
}

export type SpawnedAgentTone = "working" | "attention" | "done" | "failed" | "quiet";

export interface SpawnedAgentRow {
  readonly key: string;
  readonly title: string;
  readonly driver: string;
  /** What it is doing now, or what it reported when it finished, as one plain line. */
  readonly detail: string | null;
  readonly state: SubagentRowState;
  /** Shown beside a row that is not working ("done", "paused · 2 queued"); null while it works. */
  readonly statusLabel: string | null;
  readonly tone: SpawnedAgentTone;
  readonly elapsed: string | null;
  readonly childThreadId: ThreadId | null;
}

export interface SpawnedAgentsPresentation {
  readonly heading: string;
  /** "4 working · 1 done · 1 failed". */
  readonly summary: string;
  readonly working: boolean;
  /** Any agent still moves (working, waiting, queued or paused), so the group reads live. */
  readonly active: boolean;
  readonly elapsed: string | null;
  readonly rows: ReadonlyArray<SpawnedAgentRow>;
}

function toneOf(state: SubagentRowState): SpawnedAgentTone {
  switch (state) {
    case "working":
      return "working";
    case "waiting":
    case "queued":
    case "paused":
      return "attention";
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "stopped":
    case "idle":
      return "quiet";
  }
}

function epochMs(value: unknown): number | null {
  if (DateTime.isDateTime(value)) return DateTime.toEpochMillis(value);
  // A cached payload may hold the ISO string the item was decoded from.
  if (typeof value === "string") {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

function elapsedLabel(startMs: number | null, endMs: number | null, nowMs: number, live: boolean) {
  if (startMs === null) return null;
  const end = live ? nowMs : endMs;
  return end === null ? null : formatAgentElapsed(end - startMs);
}

/**
 * The agents one turn spawned as the thinking log shows them: each with its provider, title,
 * current step, state and elapsed time, and the group's header. The same shared state and labels
 * as web's SpawnedAgentLog.
 */
export function presentSpawnedAgents(
  agents: ReadonlyArray<SpawnedAgentInput>,
  nowMs: number,
): SpawnedAgentsPresentation {
  let startMs: number | null = null;
  let endMs: number | null = null;
  let endUnknown = false;
  const rows = agents.map(({ item, live, control }): SpawnedAgentRow => {
    const status = live?.status ?? item.status;
    const state = subagentRowState(status, control);
    const start = epochMs(live?.startedAt ?? item.startedAt);
    const end = epochMs(live?.completedAt ?? item.completedAt);
    if (start !== null) startMs = startMs === null ? start : Math.min(startMs, start);
    if (end !== null) endMs = endMs === null ? end : Math.max(endMs, end);
    else endUnknown = true;
    const working = state === "working";
    return {
      key: item.id,
      title: formatSubagentDisplayTitle(item.title?.trim() || "Subagent"),
      driver: item.driver,
      detail: subagentDetailPreview({
        status,
        result: live?.result ?? item.result,
        progress: live?.progress ?? item.progress,
      }),
      state,
      statusLabel: working ? null : subagentRowStateLabel(state, control),
      tone: toneOf(state),
      elapsed: elapsedLabel(start, end, nowMs, working),
      childThreadId: item.childThreadId,
    };
  });
  const states = rows.map((row) => row.state);
  const working = states.includes("working");
  return {
    heading: spawnedAgentsHeading(agents.length),
    summary: summarizeSubagentRowStates(states),
    working,
    active: states.some(subagentRowIsActive),
    elapsed: elapsedLabel(startMs, endUnknown ? null : endMs, nowMs, working),
    rows,
  };
}
