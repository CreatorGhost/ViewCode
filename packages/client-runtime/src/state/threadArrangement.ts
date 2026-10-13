import type { OrchestrationThreadShell } from "@t3tools/contracts";

import { isChildAgentRunning, resolveSpawnedAgentRowStatus } from "./childAgents.ts";
import type { SidebarThreadRowEntry, SidebarThreadTreeNode } from "./threadTree.ts";

/**
 * How a project folder orders its chats and the agents inside each chat, and
 * the "Needs you / Working / New" counts above the list. Shared by the web
 * sidebar and the mobile Home list so both arrange a folder the same way.
 * Generic over the row record; callers pass the thread shell through
 * accessors where needed.
 */

/** The groups a chat's agents fall into, in display order. */
export type AgentStatusGroup = "working" | "needs-you" | "failed" | "done";

export const AGENT_STATUS_GROUPS: ReadonlyArray<AgentStatusGroup> = [
  "working",
  "needs-you",
  "failed",
  "done",
];

export const AGENT_STATUS_GROUP_LABEL: Record<AgentStatusGroup, string> = {
  working: "Working",
  "needs-you": "Needs you",
  failed: "Failed",
  done: "Done",
};

type AgentStatusInput = Pick<
  OrchestrationThreadShell,
  "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/**
 * Which group an agent shows in, from the same status its row in the lead's
 * chat shows. An agent that has not run its first turn yet is about to, so it
 * counts as working; a stopped one is finished and reads as done.
 */
export function resolveAgentStatusGroup(thread: AgentStatusInput): AgentStatusGroup {
  switch (resolveSpawnedAgentRowStatus(thread, "started")) {
    case "approval":
    case "input":
      return "needs-you";
    case "failed":
      return "failed";
    case "running":
    case "idle":
    case null:
      return "working";
    case "done":
    case "stopped":
    case "queued":
      return "done";
  }
}

/** How a folder orders its chats and their agents. Status is the default. */
export type FolderSortOrder = "status" | "recent" | "name";

export const FOLDER_SORT_ORDERS: ReadonlyArray<FolderSortOrder> = ["status", "recent", "name"];

export const FOLDER_SORT_ORDER_LABEL: Record<FolderSortOrder, string> = {
  status: "Status",
  recent: "Recent",
  name: "Name",
};

export const DEFAULT_FOLDER_SORT_ORDER: FolderSortOrder = "status";

export function isFolderSortOrder(value: unknown): value is FolderSortOrder {
  return value === "status" || value === "recent" || value === "name";
}

type ActivityInput = Pick<OrchestrationThreadShell, "createdAt" | "latestTurn"> & {
  readonly latestUserMessageAt?: string | null | undefined;
};

function parseMs(value: string | null | undefined): number {
  if (value == null) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * When a thread last moved: its newest message or turn stamp, else its
 * creation. "Newest first" everywhere in a folder means this.
 */
export function threadActivityAtMs(thread: ActivityInput): number {
  return Math.max(
    parseMs(thread.createdAt),
    parseMs(thread.latestUserMessageAt),
    parseMs(thread.latestTurn?.requestedAt),
    parseMs(thread.latestTurn?.startedAt),
    parseMs(thread.latestTurn?.completedAt),
  );
}

type SortableThread = ActivityInput &
  AgentStatusInput & { readonly id: string; readonly title: string };

const nameCollator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function byRecent<T extends SortableThread>(left: T, right: T): number {
  return (
    threadActivityAtMs(right) - threadActivityAtMs(left) ||
    (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

function byName<T extends SortableThread>(left: T, right: T): number {
  return nameCollator.compare(left.title, right.title) || byRecent(left, right);
}

/**
 * Agents in display order. Status: Working, Needs you, Failed, Done, newest
 * first inside each group, so every group is one contiguous run. Recent:
 * newest first. Name: A to Z.
 */
export function sortChatAgents<T extends SortableThread>(
  agents: ReadonlyArray<T>,
  order: FolderSortOrder,
): T[] {
  // Copy then .sort(): Hermes (mobile) has no .toSorted().
  const sorted = [...agents];
  if (order === "name") return sorted.sort(byName);
  if (order === "recent") return sorted.sort(byRecent);
  const rank = new Map(
    sorted.map((agent) => [agent, AGENT_STATUS_GROUPS.indexOf(resolveAgentStatusGroup(agent))]),
  );
  return sorted.sort((left, right) => rank.get(left)! - rank.get(right)! || byRecent(left, right));
}

/**
 * A folder's chats under a non-status order: Recent is newest activity
 * first, Name is A to Z. Status keeps the caller's own order, which already
 * groups chats by what they need.
 */
export function sortFolderChats<T extends SortableThread>(
  chats: ReadonlyArray<T>,
  order: Exclude<FolderSortOrder, "status">,
): T[] {
  return [...chats].sort(order === "name" ? byName : byRecent);
}

/** Per-group agent counts below a chat, for its folded summary ("◐ 4 ✓ 13"). */
export type AgentGroupCounts = Readonly<Record<AgentStatusGroup, number>>;

export function countAgentGroups<T>(
  node: SidebarThreadTreeNode<T>,
  groupOf: (thread: T) => AgentStatusGroup,
): AgentGroupCounts {
  const counts = { working: 0, "needs-you": 0, failed: 0, done: 0 };
  const visit = (child: SidebarThreadTreeNode<T>) => {
    counts[groupOf(child.thread)] += 1;
    child.children.forEach(visit);
  };
  node.children.forEach(visit);
  return counts;
}

export type ChatRowEntry<T> =
  | { readonly kind: "thread"; readonly key: string; readonly row: SidebarThreadRowEntry<T> }
  /** A label above one status group of the chat's own agents. */
  | {
      readonly kind: "group";
      readonly key: string;
      readonly leadKey: string;
      readonly group: AgentStatusGroup;
      readonly count: number;
    }
  /** The "Done (N)" disclosure; while closed, the done agents are left out. */
  | {
      readonly kind: "done";
      readonly key: string;
      readonly leadKey: string;
      readonly count: number;
      readonly expanded: boolean;
    };

/**
 * One chat and its expanded agents in render order, like
 * `flattenSidebarThreadNode`, plus status groups for the chat's own agents
 * when `groupOf` is given (Status order; children must already be sorted by
 * `sortChatAgents`). Labels appear only when the agents span more than one
 * group. Done folds behind "Done (N)" unless `isDoneExpanded` says otherwise,
 * but only when other agents sit beside it: a chat whose agents are all done
 * already folds them behind its own disclosure. Deeper agents nest under
 * their parent without labels.
 */
export function flattenChatRows<T>(
  root: SidebarThreadTreeNode<T>,
  input: {
    readonly isExpanded: (key: string) => boolean;
    readonly groupOf: ((thread: T) => AgentStatusGroup) | null;
    readonly isDoneExpanded: (leadKey: string) => boolean;
  },
): ChatRowEntry<T>[] {
  const rows: ChatRowEntry<T>[] = [];
  const visit = (
    node: SidebarThreadTreeNode<T>,
    depth: number,
    isLastSibling: boolean,
    guides: readonly boolean[],
  ) => {
    rows.push({ kind: "thread", key: node.key, row: { node, depth, isLastSibling, guides } });
  };
  const visitSubtree = (
    node: SidebarThreadTreeNode<T>,
    depth: number,
    isLastSibling: boolean,
    guides: readonly boolean[],
  ) => {
    visit(node, depth, isLastSibling, guides);
    if (node.children.length === 0 || !input.isExpanded(node.key)) return;
    const childGuides = [...guides, !isLastSibling];
    node.children.forEach((child, index) =>
      visitSubtree(child, depth + 1, index === node.children.length - 1, childGuides),
    );
  };

  visit(root, 0, true, []);
  if (root.children.length === 0 || !input.isExpanded(root.key)) return rows;
  if (input.groupOf === null) {
    root.children.forEach((child, index) =>
      visitSubtree(child, 1, index === root.children.length - 1, []),
    );
    return rows;
  }

  const groupOf = input.groupOf;
  const groups = root.children.map((child) => groupOf(child.thread));
  const distinct = new Set(groups);
  const labelled = distinct.size > 1;
  const foldsDone = labelled && distinct.has("done");
  const doneExpanded = !foldsDone || input.isDoneExpanded(root.key);
  const doneCount = groups.filter((group) => group === "done").length;
  // The last rendered child ends the connector, so a closed Done group moves it up.
  const lastRenderedIndex = doneExpanded ? root.children.length - 1 : groups.indexOf("done") - 1;
  root.children.forEach((child, index) => {
    const group = groups[index]!;
    if (labelled && group !== groups[index - 1]) {
      rows.push(
        group === "done" && foldsDone
          ? {
              kind: "done",
              key: `done:${root.key}`,
              leadKey: root.key,
              count: doneCount,
              expanded: doneExpanded,
            }
          : {
              kind: "group",
              key: `group:${root.key}:${group}`,
              leadKey: root.key,
              group,
              count: groups.filter((candidate) => candidate === group).length,
            },
      );
    }
    if (group === "done" && !doneExpanded) return;
    visitSubtree(child, 1, index === lastRenderedIndex, []);
  });
  return rows;
}

/** What the smart strip above the list counts, and what it filters to. */
export type SidebarAttentionFilter = "needs-you" | "working" | "new";

export type SidebarAttentionCounts = Readonly<Record<SidebarAttentionFilter, number>>;

type AttentionInput = Pick<
  OrchestrationThreadShell,
  "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/**
 * The one strip item a thread (chat or agent) counts toward, if any: waiting
 * on the user (approval or question) outranks working, which outranks a
 * finish the user has not seen yet.
 */
export function resolveSidebarAttention(
  thread: AttentionInput,
  isUnseen: (thread: AttentionInput) => boolean,
): SidebarAttentionFilter | null {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs-you";
  if (isChildAgentRunning(thread)) return "working";
  return isUnseen(thread) ? "new" : null;
}

/** Counts every listed thread once, chats and agents alike. */
export function countSidebarAttention<T extends AttentionInput>(
  threads: ReadonlyArray<T>,
  isUnseen: (thread: T) => boolean,
): SidebarAttentionCounts {
  const counts = { "needs-you": 0, working: 0, new: 0 };
  for (const thread of threads) {
    const attention = resolveSidebarAttention(
      thread,
      isUnseen as (thread: AttentionInput) => boolean,
    );
    if (attention !== null) counts[attention] += 1;
  }
  return counts;
}

/**
 * A turn finished after the user last opened the thread. A thread never
 * opened counts as seen, so a fresh install does not light up its history.
 */
export function hasUnseenCompletion(thread: {
  readonly latestTurn?: { readonly completedAt?: string | null | undefined } | null | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}): boolean {
  if (!thread.latestTurn?.completedAt) return false;
  const completedAt = Date.parse(thread.latestTurn.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}
