import type { OrchestrationThreadShell } from "../viewcodeThread.ts";
import {
  AgentControlState,
  EnvironmentId,
  ThreadId,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2TurnItemStatus,
} from "@t3tools/contracts";
import { threadOwnNeed } from "@t3tools/shared/threadNeedsYou";

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
  /** What its lead knows about it; see `ChildAgentRecord`. */
  readonly record: ChildAgentRecord | undefined;
}

/**
 * What a lead knows about one of its agents: the status of its subagent record. A
 * provider-native subagent runs inside the lead's provider session and its own thread never gets
 * a run, so its thread alone always reads idle; the record is the live truth.
 */
export interface ChildAgentRecord {
  readonly status: OrchestrationV2TurnItemStatus;
}

type LeadShellInput = {
  readonly environmentId: EnvironmentId;
  readonly runningSubagentThreadIds?: ReadonlyArray<ThreadId> | undefined;
  readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask> | undefined;
};

const RUNNING_RECORD: ChildAgentRecord = { status: "running" };

/**
 * The agents their leads' provider sessions are running now, read from the leads' shells (no
 * child subscriptions): `runningSubagentThreadIds`, and the background roster for servers that
 * predate it. Returns a lookup by child thread.
 */
export function childAgentRecordsFromShells(
  threads: ReadonlyArray<LeadShellInput>,
): (thread: {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
}) => ChildAgentRecord | undefined {
  const running = new Set<string>();
  const key = (environmentId: EnvironmentId, threadId: ThreadId) =>
    `${environmentId}\u0000${threadId}`;
  for (const thread of threads) {
    for (const childId of thread.runningSubagentThreadIds ?? []) {
      running.add(key(thread.environmentId, childId));
    }
    for (const task of thread.pendingBackgroundTasks ?? []) {
      if (task.kind === "subagent" && task.childThreadId !== undefined) {
        running.add(key(thread.environmentId, task.childThreadId));
      }
    }
  }
  return (thread) =>
    running.has(key(thread.environmentId, thread.id)) ? RUNNING_RECORD : undefined;
}

function recordIsActive(record: ChildAgentRecord | null | undefined): boolean {
  return (
    record?.status === "pending" || record?.status === "running" || record?.status === "waiting"
  );
}

/**
 * A child agent counts as running while its lead's record says so, or while its own session or
 * latest turn is in flight.
 */
export function isChildAgentRunning(
  thread: Pick<OrchestrationThreadShell, "session" | "latestTurn">,
  record?: ChildAgentRecord | null | undefined,
): boolean {
  if (recordIsActive(record)) return true;
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
  threads: ReadonlyArray<T & LeadShellInput>,
  root: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId },
): ReadonlyArray<ChildAgentEntry<T>> {
  const childrenByParent = new Map<ThreadId, T[]>();
  for (const thread of threads) {
    if (thread.environmentId !== root.environmentId) continue;
    // A side chat sits beside its parent; it is not one of its agents.
    if (thread.archivedAt != null || thread.parentThreadId == null) continue;
    if ((thread as { kind?: string | null }).kind === "sidechat") continue;
    const siblings = childrenByParent.get(thread.parentThreadId);
    if (siblings) siblings.push(thread);
    else childrenByParent.set(thread.parentThreadId, [thread]);
  }
  if (childrenByParent.size === 0) return [];

  const recordOf = childAgentRecordsFromShells(threads);
  const result: ChildAgentEntry<T>[] = [];
  const visited = new Set<ThreadId>([root.threadId]);
  const visit = (parentId: ThreadId, depth: number) => {
    for (const child of childrenByParent.get(parentId) ?? []) {
      if (visited.has(child.id)) continue;
      visited.add(child.id);
      const record = recordOf(child);
      result.push({ thread: child, depth, running: isChildAgentRunning(child, record), record });
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
  threads: ReadonlyArray<T & LeadShellInput>,
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
  const rootRecord = childAgentRecordsFromShells(threads)(root);
  return [
    {
      thread: root,
      depth: 0,
      running: isChildAgentRunning(root, rootRecord),
      record: rootRecord,
    },
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
  record?: ChildAgentRecord | null | undefined,
): ChildAgentStatus {
  const need = threadOwnNeed(thread);
  if (need !== null) return need === "approval" ? "approval" : "input";
  if (isChildAgentRunning(thread, record)) return "working";
  if (record?.status === "failed" || thread.session?.status === "error") return "failed";
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

export type SpawnedAgentRowStatus =
  | "running"
  | "approval"
  | "input"
  | "failed"
  | "stopped"
  | "done"
  | "queued"
  | "idle";

export const SPAWNED_AGENT_STATUS_LABEL: Record<SpawnedAgentRowStatus, string> = {
  running: "Running",
  approval: "Needs approval",
  input: "Needs input",
  failed: "Failed",
  stopped: "Stopped",
  done: "Done",
  queued: "Queued",
  idle: "Idle",
};

/**
 * The status a spawned child agent's one-line row shows in its lead's chat.
 * Anything waiting on the user outranks running; a finished turn reads as
 * Done, a stopped one as Stopped; before its first turn a queued spawn says
 * so. `null` when the child thread is not loaded here.
 */
export function resolveSpawnedAgentRowStatus(
  thread:
    | (Pick<
        OrchestrationThreadShell,
        "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
      > & { readonly itemCount?: number | undefined })
    | null,
  delivery: "started" | "queued",
): SpawnedAgentRowStatus | null {
  if (!thread) return null;
  const status = resolveChildAgentStatus(thread);
  switch (status) {
    case "approval":
    case "input":
    case "failed":
      return status;
    case "working":
      return "running";
    case "idle":
      break;
  }
  switch (thread.latestTurn?.state) {
    case "completed":
      return "done";
    case "interrupted":
      return "stopped";
    case "error":
      return "failed";
    case "running":
      return delivery === "queued" ? "queued" : "idle";
    case undefined:
      if (delivery === "queued") return "queued";
      // A provider-native subagent's thread never gets a turn of its own; once it holds work,
      // it ran and finished.
      return (thread.itemCount ?? 0) > 0 ? "done" : "idle";
  }
}

/**
 * The one status every surface shows for an agent: what its lead's record says, then what its
 * own thread's run says, then idle. A need for the user outranks both. The thinking log passes
 * the subagent item's status; the sidebar and the Active agents bar pass
 * `childAgentRecordsFromShells`.
 */
export function resolveEffectiveAgentStatus(
  thread: Parameters<typeof resolveSpawnedAgentRowStatus>[0],
  options: {
    readonly record?: ChildAgentRecord | null | undefined;
    readonly delivery?: "started" | "queued";
  } = {},
): SpawnedAgentRowStatus | null {
  const need = thread === null ? null : threadOwnNeed(thread);
  if (need !== null) return need === "approval" ? "approval" : "input";
  switch (options.record?.status) {
    case "pending":
      return "queued";
    case "running":
    case "waiting":
      return "running";
    case "failed":
      return "failed";
    case "completed":
      return "done";
    case "cancelled":
    case "interrupted":
      return "stopped";
    case "idle":
    case undefined:
      return resolveSpawnedAgentRowStatus(thread, options.delivery ?? "started");
  }
}

/**
 * When the child's latest turn ran, for its row's elapsed time; `endMs` is
 * null while it still runs. Null before any turn started.
 */
export function spawnedAgentElapsedRange(
  thread: Pick<OrchestrationThreadShell, "latestTurn"> | null,
): { readonly startMs: number; readonly endMs: number | null } | null {
  const turn = thread?.latestTurn;
  const start = turn?.startedAt ?? turn?.requestedAt ?? null;
  const startMs = start === null ? Number.NaN : Date.parse(start);
  if (!Number.isFinite(startMs)) return null;
  const endMs = turn?.completedAt ? Date.parse(turn.completedAt) : Number.NaN;
  return { startMs, endMs: Number.isFinite(endMs) ? endMs : null };
}

/** Whole-second elapsed time for agent rows: "7s", "2m 14s", "1h 5m". */
export function formatAgentElapsed(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1_000));
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  const seconds = totalSeconds % 60;
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

/** A spawn's row title: its task, or the first line of its prompt, trimmed for one line. */
export function spawnedAgentTaskTitle(sent: {
  readonly task?: string | undefined;
  readonly body: string;
}): string {
  if (sent.task) return sent.task;
  const firstLine =
    sent.body
      .split("\n")
      .map((line) => line.replace(/^[#>*\-\s]+/, "").trim())
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > 120 ? `${firstLine.slice(0, 119).trimEnd()}…` : firstLine;
}
