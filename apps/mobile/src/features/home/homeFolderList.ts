import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { threadSearchMatchKey } from "@t3tools/client-runtime/state/thread-search";
import {
  resolveSettledThreadTimestamp,
  sortActiveThreadsByOrderKey,
  sortPinnedThreadsByOrderKey,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  buildSidebarThreadTree,
  flattenSidebarThreadNode,
  partitionThreadTreeNodes,
  selectThreadTreeSearchMatches,
  type SidebarThreadTreeNode,
} from "@t3tools/client-runtime/state/thread-tree";
import { formatSubagentModelLabel } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  summarizeAgentTreeControl,
  type AgentTreeControlSummary,
} from "@t3tools/client-runtime/state/child-agents";
import type { AgentControlState, EnvironmentId, ServerConfig } from "@t3tools/contracts";
import { threadPullRequestSearchTerms } from "@t3tools/shared/threadPullRequests";

import { scopedProjectKey } from "../../lib/scopedEntities";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  buildThreadListV2ListItems,
  getThreadListV2OrderedSection,
  type ThreadListV2Item,
  type ThreadListV2PendingListItem,
  type ThreadListV2SnoozedShelfListItem,
  type ThreadListV2ThreadListItem,
  threadListV2ListItemsAreEqual,
} from "../threads/threadListV2";
import type { ThreadMoveAvailability } from "../threads/threadOrder";
import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "../threads/threadOrder";
import type { HomeProjectScope } from "./homeThreadList";
import { agentStatusRank, sortAgentsByStatus, type HomeAgentStatus } from "../agents/agentStatus";

/**
 * Home as project folders: pinned leads on top, then one collapsible folder
 * per project holding its lead threads (the ones a user started), each with
 * its child agents behind a disclosure row, and a collapsed "Settled · N" row
 * at the bottom. Snoozed trees keep the shared shelf at the end. Lead rows
 * are the ordinary v2 rows, so swipe and long-press actions stay as they are.
 */

export type { HomeAgentStatus };

type AgentControlByThreadKey = ReadonlyMap<string, Pick<AgentControlState, "paused" | "queued">>;

/** Home's status chips. `needs-you` is a decision or a failure waiting on the user. */
export type HomeStatusFilter = "all" | "working" | "needs-you";

export function matchesHomeStatusFilter(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn"
  >,
  filter: HomeStatusFilter,
): boolean {
  if (filter === "all") return true;
  const status = resolveHomeAgentStatus(thread);
  return filter === "working"
    ? status === "working"
    : status === "needs-you" || status === "failed";
}

/** Lead trees each chip would keep, for the chip badges. */
export function countHomeStatusFilters(
  threads: ReadonlyArray<EnvironmentThreadShell>,
): Record<HomeStatusFilter, number> {
  const counts = { all: 0, working: 0, "needs-you": 0 };
  const rootOf = new Map<string, string>();
  const byKey = new Map(threads.map((thread) => [threadKey(thread), thread]));
  const resolveRoot = (thread: EnvironmentThreadShell): string => {
    const key = threadKey(thread);
    const cached = rootOf.get(key);
    if (cached !== undefined) return cached;
    const seen = new Set([key]);
    let current = thread;
    for (let parent = parentKey(current); parent !== null && !seen.has(parent);) {
      const next = byKey.get(parent);
      if (next === undefined) break;
      seen.add(parent);
      current = next;
      parent = parentKey(current);
    }
    const root = threadKey(current);
    rootOf.set(key, root);
    return root;
  };
  for (const filter of ["working", "needs-you"] as const) {
    const roots = new Set<string>();
    for (const thread of threads) {
      if (matchesHomeStatusFilter(thread, filter)) roots.add(resolveRoot(thread));
    }
    counts[filter] = roots.size;
  }
  counts.all = threads.filter((thread) => parentKey(thread) === null).length;
  return counts;
}

export function resolveHomeAgentStatus(
  thread: Pick<
    EnvironmentThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestTurn"
  >,
): HomeAgentStatus {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return "needs-you";
  const status = thread.session?.status;
  if (status === "running" || status === "starting" || thread.latestTurn?.state === "running") {
    return "working";
  }
  if (status === "error") return "failed";
  if (status === undefined || status === "stopped" || status === "interrupted") return "stopped";
  return "idle";
}

/**
 * The model an agent runs, named the way its server's provider lists it,
 * or a compact form of the raw id when the server does not list it.
 */
export function resolveHomeAgentModelLabel(
  serverConfigs: ReadonlyMap<EnvironmentId, Pick<ServerConfig, "providers">>,
  thread: Pick<EnvironmentThreadShell, "environmentId" | "modelSelection" | "session">,
): string | null {
  const instanceId = thread.session?.providerInstanceId ?? thread.modelSelection.instanceId;
  const slug = thread.modelSelection.model;
  const model = serverConfigs
    .get(thread.environmentId)
    ?.providers.find((provider) => provider.instanceId === instanceId)
    ?.models.find((candidate) => candidate.slug === slug);
  return model ? (model.shortName ?? model.name) : formatSubagentModelLabel(slug, null);
}

export interface HomeFolderHeaderItem {
  /** Position in the folder card; null outside a folder. */
  readonly folderEdge?: HomeFolderEdge | null;
  readonly type: "folder-header";
  readonly key: string;
  readonly folderKey: string;
  readonly title: string;
  readonly scope: HomeProjectScope;
  /** Lead threads outside the Settled row. */
  readonly count: number;
  /** Working threads (leads and agents) outside the Settled row. */
  readonly workingCount: number;
  readonly expanded: boolean;
}

export interface HomeFolderLeadItem {
  /** Position in the folder card; null outside a folder. */
  readonly folderEdge?: HomeFolderEdge | null;
  readonly type: "folder-lead";
  readonly key: string;
  readonly entry: ThreadListV2ThreadListItem;
  /** Rows inside a folder drop the project line the folder already names. */
  readonly inFolder: boolean;
  /** The lead's agent tree (lead included) for Stop all / Resume; null without agents. */
  readonly agentTree: AgentTreeControlSummary | null;
  /** Agents a settled lead folds into its row instead of an "N agents" row; 0 otherwise. */
  readonly foldedAgentCount: number;
}

export interface HomeFolderAgentsToggleItem {
  /** Position in the folder card; null outside a folder. */
  readonly folderEdge?: HomeFolderEdge | null;
  readonly type: "folder-agents";
  readonly key: string;
  readonly leadKey: string;
  readonly agentCount: number;
  readonly workingCount: number;
  /** Agents below the lead stopped by the user. */
  readonly pausedCount: number;
  readonly expanded: boolean;
  readonly muted: boolean;
}

export interface HomeFolderChildItem {
  /** Position in the folder card; null outside a folder. */
  readonly folderEdge?: HomeFolderEdge | null;
  readonly type: "folder-child";
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  /** 1 for a lead's own agents, 2 for theirs, … */
  readonly depth: number;
  readonly status: HomeAgentStatus;
  /** Its session or turn is in flight, even while `status` says paused. */
  readonly running: boolean;
  /** Agent messages waiting for it. */
  readonly queued: number;
  readonly muted: boolean;
}

export interface HomeFolderSettledItem {
  /** Position in the folder card; null outside a folder. */
  readonly folderEdge?: HomeFolderEdge | null;
  readonly type: "folder-settled";
  readonly key: string;
  readonly folderKey: string;
  readonly count: number;
  readonly expanded: boolean;
}

/**
 * Where a row sits in its folder's card. Rows are virtualized one by one, so
 * the card is drawn by each row: `first` rounds the top, `last` the bottom.
 * Null for rows outside any folder.
 */
export interface HomeFolderEdge {
  readonly first: boolean;
  readonly last: boolean;
}

export type HomeFolderListItem =
  | HomeFolderHeaderItem
  | HomeFolderLeadItem
  | HomeFolderAgentsToggleItem
  | HomeFolderChildItem
  | HomeFolderSettledItem
  | ThreadListV2PendingListItem
  | ThreadListV2SnoozedShelfListItem;

export interface HomeFolderList {
  readonly items: HomeFolderListItem[];
  readonly nextSnoozeWakeAt: string | null;
}

type Bucket = "snoozed" | "settled" | "pinned" | "active";

function threadKey(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) {
  return `${thread.environmentId}:${thread.id}`;
}

function parentKey(thread: EnvironmentThreadShell) {
  return thread.parentThreadId ? `${thread.environmentId}:${thread.parentThreadId}` : null;
}

/** The same title / PR / message-match rule as the flat list. */
function matchesHomeSearch(
  thread: EnvironmentThreadShell,
  query: string,
  matchedThreadKeys: ReadonlySet<string> | undefined,
): boolean {
  return (
    thread.title.toLocaleLowerCase().includes(query) ||
    threadPullRequestSearchTerms(thread).some((term) => term.toLocaleLowerCase().includes(query)) ||
    matchedThreadKeys?.has(
      threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
    ) === true
  );
}

function parseTimestampMs(isoDate: string | null | undefined): number {
  const parsed = Date.parse(isoDate ?? "");
  return Number.isNaN(parsed) ? 0 : parsed;
}

export function buildHomeFolderList(input: {
  /** Live, unarchived shells. */
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  /** Folders in display order, already narrowed to the selected project. */
  readonly scopes: ReadonlyArray<HomeProjectScope>;
  /** True while the list shows one project: threads outside it are hidden
      rather than listed loose. */
  readonly projectScoped: boolean;
  /** Already narrowed to the environment, project and search. */
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly environmentId: EnvironmentId | null;
  readonly searchQuery: string;
  /** Status chip; a match keeps its lead and agent tree, as search does. */
  readonly statusFilter?: HomeStatusFilter;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  /** Same capability gates as the flat list. Absent = no gating (tests). */
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly collapsedFolderKeys: ReadonlySet<string>;
  readonly expandedLeadKeys: ReadonlySet<string>;
  readonly expandedSettledFolderKeys: ReadonlySet<string>;
  readonly snoozedShelfExpanded: boolean;
  readonly snoozeLabelNow?: string;
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  readonly shelfPreferencesLoading?: boolean;
  /** Agent control state by `${environmentId}:${threadId}`. */
  readonly agentControl?: AgentControlByThreadKey;
}): HomeFolderList {
  const { now } = input;
  const folderKeyByProjectKey = new Map<string, string>();
  for (const scope of input.scopes) {
    for (const ref of scope.projectRefs) {
      folderKeyByProjectKey.set(scopedProjectKey(ref.environmentId, ref.projectId), scope.key);
    }
  }

  const hasFolder = (thread: EnvironmentThreadShell) =>
    folderKeyByProjectKey.has(scopedProjectKey(thread.environmentId, thread.projectId));

  let threads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (!input.projectScoped || hasFolder(thread)),
  );
  const query = input.searchQuery.trim().toLocaleLowerCase();
  const searching = query.length > 0;
  let searchExpandKeys: ReadonlySet<string> = new Set();
  if (searching) {
    const selection = selectThreadTreeSearchMatches({
      threads,
      threadKeyOf: threadKey,
      parentKeyOf: parentKey,
      matches: (thread) => matchesHomeSearch(thread, query, input.matchedThreadKeys),
    });
    threads = threads.filter((thread) => selection.keys.has(threadKey(thread)));
    searchExpandKeys = selection.expandKeys;
  }
  const statusFilter = input.statusFilter ?? "all";
  if (statusFilter !== "all") {
    const selection = selectThreadTreeSearchMatches({
      threads,
      threadKeyOf: threadKey,
      parentKeyOf: parentKey,
      matches: (thread) => matchesHomeStatusFilter(thread, statusFilter),
    });
    threads = threads.filter((thread) => selection.keys.has(threadKey(thread)));
    searchExpandKeys = new Set([...searchExpandKeys, ...selection.expandKeys]);
  }

  // Snooze outranks settlement and pinning until the thread wakes, as in the
  // flat list. A message waiting in the outbox keeps a thread active.
  let nextSnoozeWakeAt: string | null = null;
  const bucketByKey = new Map<string, Bucket>();
  for (const thread of threads) {
    const key = threadKey(thread);
    let bucket: Bucket = "active";
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now })
    ) {
      bucket = "snoozed";
      if (
        thread.snoozedUntil != null &&
        (nextSnoozeWakeAt === null ||
          parseTimestampMs(thread.snoozedUntil) < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
    } else if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      input.queuedThreadKeys?.has(key) !== true
    ) {
      bucket = "settled";
    } else if (thread.pinnedAt != null) {
      bucket = "pinned";
    }
    bucketByKey.set(key, bucket);
  }
  const bucketOf = (thread: EnvironmentThreadShell) => bucketByKey.get(threadKey(thread));

  const pending =
    input.pendingOrder == null
      ? null
      : reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({
            threads: input.threads,
            section: input.pendingOrder.section,
            pendingOrder: null,
            now,
            ...(input.settlementEnvironmentIds
              ? { settlementEnvironmentIds: input.settlementEnvironmentIds }
              : {}),
            ...(input.snoozeEnvironmentIds
              ? { snoozeEnvironmentIds: input.snoozeEnvironmentIds }
              : {}),
            ...(input.queuedThreadKeys ? { queuedThreadKeys: input.queuedThreadKeys } : {}),
          }),
        );
  // Roots of one folder mix every bucket; each bucket keeps the flat list's
  // order: saved arrangement for active, newest settle first for settled.
  const sortRoots = (roots: readonly EnvironmentThreadShell[]) => {
    const active = roots.filter((thread) => bucketOf(thread) === "active");
    const settled = roots
      .filter((thread) => bucketOf(thread) === "settled")
      .sort(
        (left, right) =>
          parseTimestampMs(resolveSettledThreadTimestamp(right)) -
          parseTimestampMs(resolveSettledThreadTimestamp(left)),
      );
    const snoozed = roots
      .filter((thread) => bucketOf(thread) === "snoozed")
      .sort(
        (left, right) => parseTimestampMs(left.snoozedUntil) - parseTimestampMs(right.snoozedUntil),
      );
    return [
      ...applyPendingThreadOrder(sortActiveThreadsByOrderKey(active), "active", pending),
      ...settled,
      ...snoozed,
    ];
  };

  const tree = buildSidebarThreadTree({
    projects: input.scopes,
    threads,
    projectKeyOf: (scope) => scope.key,
    threadKeyOf: threadKey,
    parentKeyOf: parentKey,
    folderKeyOf: (thread) =>
      folderKeyByProjectKey.get(scopedProjectKey(thread.environmentId, thread.projectId)) ?? "",
    // A thread whose project this client does not know yet has no folder; it
    // lists loose on top with the pinned leads instead of disappearing.
    isPinned: (thread) => bucketOf(thread) === "pinned" || !hasFolder(thread),
    sortPinned: (roots) => [
      ...applyPendingThreadOrder(
        sortPinnedThreadsByOrderKey(roots.filter((thread) => bucketOf(thread) === "pinned")),
        "pinned",
        pending,
      ),
      ...sortRoots(roots.filter((thread) => bucketOf(thread) !== "pinned")),
    ],
    sortRoots,
    // Working agents first, as in the thread screen's panel; otherwise in the
    // order they were spawned.
    sortChildren: (children) =>
      sortAgentsByStatus(
        [...children].sort(
          (left, right) => parseTimestampMs(left.createdAt) - parseTimestampMs(right.createdAt),
        ),
        (child) => agentStatusRank(resolveHomeAgentStatus(child)),
      ),
    isWorking: (thread) => resolveHomeAgentStatus(thread) === "working",
  });

  // Lead rows are decorated by the flat list's builder so they carry the same
  // time labels, snooze clocks and move availability.
  const leadVariants: ThreadListV2Item[] = [];
  const addLead = (node: SidebarThreadTreeNode<EnvironmentThreadShell>, bucket: Bucket) => {
    leadVariants.push({
      thread: node.thread,
      variant: bucket === "settled" || bucket === "snoozed" ? "slim" : "card",
      snoozed: bucket === "snoozed",
      pinned: bucket === "pinned",
      isLast: false,
    });
  };
  const topNodes: SidebarThreadTreeNode<EnvironmentThreadShell>[] = [];
  const snoozedNodes: SidebarThreadTreeNode<EnvironmentThreadShell>[] = [];
  for (const node of tree.pinned) {
    (bucketOf(node.thread) === "snoozed" ? snoozedNodes : topNodes).push(node);
  }
  const folders = tree.folders.map((folder) => {
    const awake = folder.nodes.filter((node) => bucketOf(node.thread) !== "snoozed");
    for (const node of folder.nodes) {
      if (bucketOf(node.thread) === "snoozed") snoozedNodes.push(node);
    }
    return {
      folder,
      ...partitionThreadTreeNodes(awake, (thread) => bucketOf(thread) === "settled"),
    };
  });
  snoozedNodes.sort(
    (left, right) =>
      parseTimestampMs(left.thread.snoozedUntil) - parseTimestampMs(right.thread.snoozedUntil),
  );
  for (const node of topNodes) addLead(node, bucketOf(node.thread) ?? "active");
  for (const { active, settled } of folders) {
    for (const node of active) addLead(node, "active");
    for (const node of settled) addLead(node, "settled");
  }
  for (const node of snoozedNodes) addLead(node, "snoozed");
  const entryByKey = new Map<string, ThreadListV2ThreadListItem>();
  for (const entry of buildThreadListV2ListItems({
    items: leadVariants,
    pendingTasks: [],
    ...(input.snoozeLabelNow !== undefined ? { snoozeLabelNow: input.snoozeLabelNow } : {}),
    ...(input.snoozeEnvironmentIds ? { snoozeEnvironmentIds: input.snoozeEnvironmentIds } : {}),
    ...(input.queuedThreadKeys ? { queuedThreadKeys: input.queuedThreadKeys } : {}),
    ...(input.moveAvailability ? { moveAvailability: input.moveAvailability } : {}),
  })) {
    if (entry.type === "v2-thread") entryByKey.set(threadKey(entry.item.thread), entry);
  }

  const agentControl: AgentControlByThreadKey = input.agentControl ?? new Map();
  const items: HomeFolderListItem[] = [];
  const pushTree = (
    node: SidebarThreadTreeNode<EnvironmentThreadShell>,
    inFolder: boolean,
    muted: boolean,
    settled = false,
  ) => {
    const entry = entryByKey.get(node.key);
    if (entry === undefined) return;
    if (node.children.length === 0) {
      items.push({
        type: "folder-lead",
        key: entry.key,
        entry,
        inFolder,
        agentTree: null,
        foldedAgentCount: 0,
      });
      return;
    }
    const tree = flattenSidebarThreadNode(node, () => true).map((row) => ({
      key: row.node.key,
      thread: row.node.thread,
      depth: row.depth,
      running: resolveHomeAgentStatus(row.node.thread) === "working",
    }));
    const agentTree = summarizeAgentTreeControl(tree, agentControl);
    const agents = tree.slice(1);
    // A settled tree whose agents are all quiet folds them into the lead row;
    // the thread screen still lists them. A working, waiting, failed or paused
    // agent keeps the disclosure, and so does a search that matched one.
    const quiet = agents.every((row) => {
      const status = resolveHomeAgentStatus(row.thread);
      return (status === "idle" || status === "stopped") && !agentControl.get(row.key)?.paused;
    });
    if (settled && quiet && !searchExpandKeys.has(node.key)) {
      items.push({
        type: "folder-lead",
        key: entry.key,
        entry,
        inFolder,
        agentTree,
        foldedAgentCount: node.descendantCount,
      });
      return;
    }
    items.push({
      type: "folder-lead",
      key: entry.key,
      entry,
      inFolder,
      agentTree,
      foldedAgentCount: 0,
    });
    const expanded = input.expandedLeadKeys.has(node.key) || searchExpandKeys.has(node.key);
    items.push({
      type: "folder-agents",
      key: `folder-agents:${node.key}`,
      leadKey: node.key,
      agentCount: node.descendantCount,
      workingCount: node.workingDescendantCount,
      pausedCount: agents.filter((row) => agentControl.get(row.key)?.paused === true).length,
      expanded,
      muted,
    });
    if (!expanded) return;
    // An open lead shows its whole tree; nested agents indent by depth.
    for (const row of agents) {
      const control = agentControl.get(row.key);
      items.push({
        type: "folder-child",
        key: `folder-child:${row.key}`,
        thread: row.thread,
        depth: row.depth,
        status: control?.paused ? "paused" : resolveHomeAgentStatus(row.thread),
        running: row.running,
        queued: control?.queued ?? 0,
        muted,
      });
    }
  };

  for (const node of topNodes) pushTree(node, false, bucketOf(node.thread) === "settled");

  const pendingByFolderKey = new Map<string, PendingNewTask[]>();
  const looseTasks: PendingNewTask[] = [];
  for (const task of input.pendingTasks) {
    const folderKey = folderKeyByProjectKey.get(
      scopedProjectKey(task.environmentId, task.projectId),
    );
    if (folderKey === undefined) {
      looseTasks.push(task);
      continue;
    }
    const list = pendingByFolderKey.get(folderKey);
    if (list) list.push(task);
    else pendingByFolderKey.set(folderKey, [task]);
  }
  const pushPending = (tasks: readonly PendingNewTask[]) =>
    tasks.forEach((pendingTask, index) =>
      items.push({
        type: "v2-pending",
        key: `v2-${pendingTask.key}`,
        pendingTask,
        showPendingDivider: index === 0,
        showTrailingDivider: false,
      }),
    );
  pushPending(looseTasks);

  for (const { folder, active, settled } of folders) {
    const folderTasks = pendingByFolderKey.get(folder.key) ?? [];
    if (active.length === 0 && settled.length === 0 && folderTasks.length === 0) continue;
    const expanded = searching || !input.collapsedFolderKeys.has(folder.key);
    let workingCount = 0;
    for (const node of active) {
      workingCount +=
        node.workingDescendantCount + (resolveHomeAgentStatus(node.thread) === "working" ? 1 : 0);
    }
    items.push({
      type: "folder-header",
      key: `folder:${folder.key}`,
      folderKey: folder.key,
      title: folder.project.title,
      scope: folder.project,
      count: active.length,
      workingCount,
      expanded,
    });
    if (!expanded) continue;
    for (const node of active) pushTree(node, true, false);
    pushPending(folderTasks);
    if (settled.length === 0) continue;
    // Search only leaves matches behind, so their shelf opens by itself.
    const settledExpanded = searching || input.expandedSettledFolderKeys.has(folder.key);
    items.push({
      type: "folder-settled",
      key: `folder-settled:${folder.key}`,
      folderKey: folder.key,
      count: settled.length,
      expanded: settledExpanded,
    });
    if (settledExpanded) for (const node of settled) pushTree(node, true, true, true);
  }

  if (snoozedNodes.length > 0) {
    items.push({
      type: "v2-snoozed-shelf",
      key: "v2-snoozed-shelf",
      count: snoozedNodes.length,
      expanded: input.snoozedShelfExpanded,
      disabled: input.shelfPreferencesLoading === true,
    });
    if (input.snoozedShelfExpanded) for (const node of snoozedNodes) pushTree(node, false, true);
  }

  // A folder card runs from its header to the row before the next header or
  // the snoozed shelf; each row carries its edge so it can draw its part.
  const folderEdgeAt = new Map<number, HomeFolderEdge>();
  for (let start = 0; start < items.length; start++) {
    if (items[start]?.type !== "folder-header") continue;
    let end = start + 1;
    while (
      end < items.length &&
      items[end]?.type !== "folder-header" &&
      items[end]?.type !== "v2-snoozed-shelf"
    ) {
      end++;
    }
    for (let index = start; index < end; index++) {
      folderEdgeAt.set(index, { first: index === start, last: index === end - 1 });
    }
    start = end - 1;
  }

  // Hairlines separate consecutive lead rows only; a lead's agents and every
  // header draw their own structure.
  return {
    items: items.map((rawItem, index) => {
      const folderEdge = folderEdgeAt.get(index) ?? null;
      const item =
        rawItem.type === "v2-pending" || rawItem.type === "v2-snoozed-shelf" || folderEdge === null
          ? rawItem
          : { ...rawItem, folderEdge };
      if (item.type !== "folder-lead" && item.type !== "v2-pending") return item;
      const next = items[index + 1];
      const showTrailingDivider =
        next?.type === "folder-lead" || (next?.type === "v2-pending" && !next.showPendingDivider);
      if (item.type === "v2-pending") {
        return showTrailingDivider === item.showTrailingDivider
          ? item
          : { ...item, showTrailingDivider };
      }
      return showTrailingDivider === item.entry.showTrailingDivider
        ? item
        : { ...item, entry: { ...item.entry, showTrailingDivider } };
    }),
    nextSnoozeWakeAt,
  };
}

/** Recycled-list equality: rows re-render only when what they draw moved. */
function folderEdgesAreEqual(
  previous: HomeFolderEdge | null | undefined,
  next: HomeFolderEdge | null | undefined,
): boolean {
  return previous?.first === next?.first && previous?.last === next?.last;
}

export function homeFolderListItemsAreEqual(
  previous: HomeFolderListItem,
  item: HomeFolderListItem,
): boolean {
  if (
    item.type !== "v2-pending" &&
    item.type !== "v2-snoozed-shelf" &&
    previous.type !== "v2-pending" &&
    previous.type !== "v2-snoozed-shelf" &&
    !folderEdgesAreEqual(previous.folderEdge, item.folderEdge)
  ) {
    return false;
  }
  switch (item.type) {
    case "folder-header":
      return (
        previous.type === "folder-header" &&
        previous.key === item.key &&
        previous.title === item.title &&
        previous.scope.representative === item.scope.representative &&
        previous.count === item.count &&
        previous.workingCount === item.workingCount &&
        previous.expanded === item.expanded
      );
    case "folder-lead":
      return (
        previous.type === "folder-lead" &&
        previous.inFolder === item.inFolder &&
        previous.foldedAgentCount === item.foldedAgentCount &&
        agentTreesAreEqual(previous.agentTree, item.agentTree) &&
        threadListV2ListItemsAreEqual(previous.entry, item.entry)
      );
    case "folder-agents":
      return (
        previous.type === "folder-agents" &&
        previous.key === item.key &&
        previous.agentCount === item.agentCount &&
        previous.workingCount === item.workingCount &&
        previous.pausedCount === item.pausedCount &&
        previous.expanded === item.expanded &&
        previous.muted === item.muted
      );
    case "folder-child":
      return (
        previous.type === "folder-child" &&
        previous.key === item.key &&
        previous.thread === item.thread &&
        previous.depth === item.depth &&
        previous.status === item.status &&
        previous.running === item.running &&
        previous.queued === item.queued &&
        previous.muted === item.muted
      );
    case "folder-settled":
      return (
        previous.type === "folder-settled" &&
        previous.key === item.key &&
        previous.count === item.count &&
        previous.expanded === item.expanded
      );
    case "v2-pending":
    case "v2-snoozed-shelf":
      return (
        (previous.type === "v2-pending" || previous.type === "v2-snoozed-shelf") &&
        threadListV2ListItemsAreEqual(previous, item)
      );
  }
}

function agentTreesAreEqual(
  previous: AgentTreeControlSummary | null,
  next: AgentTreeControlSummary | null,
): boolean {
  if (previous === null || next === null) return previous === next;
  return (
    previous.running === next.running &&
    previous.paused === next.paused &&
    previous.queued === next.queued
  );
}
