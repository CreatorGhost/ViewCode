/**
 * Splits one project folder of the sidebar tree into its active threads and
 * the collapsed "Settled" group at the folder's bottom, and narrows a folder
 * to a search query. Generic over the thread record like sidebarThreadTree, so
 * tests can use plain objects.
 *
 * A lead and its child agents always travel together: the lead's settled
 * state decides where the whole tree goes, and any live thread in the tree
 * (working, or blocked on the user) keeps it active so work never hides in
 * the Settled group.
 */
import type { SidebarThreadTreeNode } from "./sidebarThreadTree";

export interface SidebarFolderSections<T> {
  readonly active: readonly SidebarThreadTreeNode<T>[];
  /** Newest settlement first. */
  readonly settled: readonly SidebarThreadTreeNode<T>[];
}

/**
 * The settled rule upstream's sidebar used: the server's settledOverride
 * (manual settle or auto-settle), honored only where the environment supports
 * settlement so a thread can never land somewhere it cannot be un-settled.
 */
export function isSidebarThreadSettled(
  thread: { readonly settledOverride?: "settled" | "active" | null | undefined },
  supportsSettlement: boolean,
): boolean {
  return supportsSettlement && thread.settledOverride === "settled";
}

/**
 * Pinned threads sit above the folders, except a settled one: as upstream,
 * settling beats pinning (the server clears the pin on settle, and a thread
 * auto-settled while pinned must not stay on top).
 */
export function isSidebarThreadPinnedOnTop(
  thread: { readonly pinnedAt?: string | null | undefined },
  isSettled: boolean,
): boolean {
  return thread.pinnedAt != null && !isSettled;
}

function subtreeHasLive<T>(
  node: SidebarThreadTreeNode<T>,
  isLive: (thread: T) => boolean,
): boolean {
  if (isLive(node.thread)) return true;
  return node.children.some((child) => subtreeHasLive(child, isLive));
}

export function partitionSidebarFolderNodes<T>(
  nodes: readonly SidebarThreadTreeNode<T>[],
  input: {
    readonly isSettled: (thread: T) => boolean;
    /** Working or waiting on the user: such a tree stays active. */
    readonly isLive: (thread: T) => boolean;
    /** Sort key for the Settled group; larger is newer. */
    readonly settledAtMs: (thread: T) => number;
  },
): SidebarFolderSections<T> {
  const active: SidebarThreadTreeNode<T>[] = [];
  const settled: SidebarThreadTreeNode<T>[] = [];
  for (const node of nodes) {
    if (input.isSettled(node.thread) && !subtreeHasLive(node, input.isLive)) settled.push(node);
    else active.push(node);
  }
  return {
    active,
    settled: settled.toSorted(
      (left, right) =>
        input.settledAtMs(right.thread) - input.settledAtMs(left.thread) ||
        left.key.localeCompare(right.key),
    ),
  };
}

/** Every thread in the given trees, parents before their children. */
export function collectSidebarTreeThreads<T>(nodes: readonly SidebarThreadTreeNode<T>[]): T[] {
  const threads: T[] = [];
  const visit = (node: SidebarThreadTreeNode<T>) => {
    threads.push(node.thread);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return threads;
}

/**
 * A matching thread keeps its whole subtree; a non-matching one stays only as
 * the path to matching child agents, so a hit is never shown without its lead.
 */
function pruneNode<T>(
  node: SidebarThreadTreeNode<T>,
  matches: (key: string) => boolean,
  isWorking: (thread: T) => boolean,
): SidebarThreadTreeNode<T> | null {
  if (matches(node.key)) return node;
  const children = node.children.flatMap((child) => pruneNode(child, matches, isWorking) ?? []);
  if (children.length === 0) return null;
  let descendantCount = children.length;
  let workingDescendantCount = 0;
  for (const child of children) {
    descendantCount += child.descendantCount;
    workingDescendantCount += child.workingDescendantCount + (isWorking(child.thread) ? 1 : 0);
  }
  return { ...node, children, descendantCount, workingDescendantCount };
}

export interface SidebarFolderSearchResult<T> extends SidebarFolderSections<T> {
  /** A match lives in the Settled group, so the group must open to show it. */
  readonly settledHasMatch: boolean;
}

/** Narrows both groups to trees containing a matched thread key. */
export function filterSidebarFolderSections<T>(
  sections: SidebarFolderSections<T>,
  input: {
    readonly matches: (key: string) => boolean;
    /** Same predicate the tree used for its working counts. */
    readonly isWorking: (thread: T) => boolean;
  },
): SidebarFolderSearchResult<T> {
  const prune = (node: SidebarThreadTreeNode<T>) =>
    pruneNode(node, input.matches, input.isWorking) ?? [];
  const active = sections.active.flatMap(prune);
  const settled = sections.settled.flatMap(prune);
  return { active, settled, settledHasMatch: settled.length > 0 };
}

/**
 * The Settled group's open state is a per-folder preference stored alongside
 * folder expansion; this prefix keeps its keys apart from project keys.
 */
export function settledGroupPreferenceKey(folderKey: string): string {
  return `settled-group:${folderKey}`;
}
