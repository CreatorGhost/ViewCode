/**
 * Pure layout for the project-grouped sidebar: pinned threads on top, then one
 * folder per project holding its top-level threads, with child agents (threads
 * whose `parentThreadId` is set) nested under the thread that spawned them.
 *
 * Generic over the thread and project records so it can be tested with plain
 * objects; the web sidebar and the mobile home list pass shells and project
 * snapshots plus accessors.
 */

export interface SidebarThreadTreeNode<T> {
  readonly key: string;
  readonly thread: T;
  readonly children: readonly SidebarThreadTreeNode<T>[];
  /** Every thread below this one, for the collapsed "N agents" hint. */
  readonly descendantCount: number;
  /** Threads below this one that are working, so a collapsed lead can show it. */
  readonly workingDescendantCount: number;
}

export interface SidebarProjectFolder<P, T> {
  readonly key: string;
  readonly project: P;
  readonly nodes: readonly SidebarThreadTreeNode<T>[];
}

export interface SidebarThreadTree<P, T> {
  readonly pinned: readonly SidebarThreadTreeNode<T>[];
  readonly folders: readonly SidebarProjectFolder<P, T>[];
  /** Resolved parent of every nested thread. Top-level threads are absent. */
  readonly parentKeyByKey: ReadonlyMap<string, string>;
  /** Folder holding each thread placed under a project (nested ones included). */
  readonly folderKeyByThreadKey: ReadonlyMap<string, string>;
}

export interface BuildSidebarThreadTreeInput<P, T> {
  /** Projects in display order. Every project gets a folder, empty or not. */
  readonly projects: readonly P[];
  /** Visible threads (archived and out-of-scope ones already removed). */
  readonly threads: readonly T[];
  readonly projectKeyOf: (project: P) => string;
  readonly threadKeyOf: (thread: T) => string;
  /** Key of the spawning thread, or null for a thread started by the user. */
  readonly parentKeyOf: (thread: T) => string | null;
  /** Folder a top-level thread belongs to. Unknown folders drop unpinned roots. */
  readonly folderKeyOf: (thread: T) => string;
  readonly isPinned: (thread: T) => boolean;
  readonly sortPinned: (threads: readonly T[]) => readonly T[];
  readonly sortRoots: (threads: readonly T[]) => readonly T[];
  readonly sortChildren: (threads: readonly T[]) => readonly T[];
  /** Whether a thread is working; defaults to never. */
  readonly isWorking?: (thread: T) => boolean;
}

/**
 * A thread nests under its parent only when the parent is visible and the
 * ancestor chain never leads back to the thread itself. Anything else (parent
 * archived, deleted, filtered out, or corrupt cyclic links) renders top-level
 * so a child agent is never lost from the list.
 */
export function buildSidebarThreadTree<P, T>(
  input: BuildSidebarThreadTreeInput<P, T>,
): SidebarThreadTree<P, T> {
  const threadByKey = new Map<string, T>();
  for (const thread of input.threads) threadByKey.set(input.threadKeyOf(thread), thread);

  const rawParentKeyOf = (key: string): string | null => {
    const thread = threadByKey.get(key);
    if (thread === undefined) return null;
    const parentKey = input.parentKeyOf(thread);
    return parentKey !== null && parentKey !== key && threadByKey.has(parentKey) ? parentKey : null;
  };

  const parentKeyByKey = new Map<string, string>();
  const childrenByParentKey = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of input.threads) {
    const key = input.threadKeyOf(thread);
    const parentKey = rawParentKeyOf(key);
    let attached = parentKey !== null;
    if (parentKey !== null) {
      // Walk up until the chain ends; reaching this thread again is a cycle.
      // Cycles elsewhere up the chain resolve on their own members, so only a
      // revisit of an already-seen ancestor stops the walk.
      const seen = new Set<string>([key]);
      let cursor: string | null = parentKey;
      while (cursor !== null) {
        if (cursor === key) {
          attached = false;
          break;
        }
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = rawParentKeyOf(cursor);
      }
    }
    if (attached && parentKey !== null) {
      parentKeyByKey.set(key, parentKey);
      const siblings = childrenByParentKey.get(parentKey);
      if (siblings) siblings.push(thread);
      else childrenByParentKey.set(parentKey, [thread]);
    } else {
      roots.push(thread);
    }
  }

  const buildNode = (thread: T): SidebarThreadTreeNode<T> => {
    const key = input.threadKeyOf(thread);
    const childThreads = childrenByParentKey.get(key);
    const children = childThreads ? input.sortChildren(childThreads).map(buildNode) : [];
    let descendantCount = children.length;
    let workingDescendantCount = 0;
    for (const child of children) {
      descendantCount += child.descendantCount;
      workingDescendantCount +=
        child.workingDescendantCount + (input.isWorking?.(child.thread) ? 1 : 0);
    }
    return { key, thread, children, descendantCount, workingDescendantCount };
  };

  const pinnedRoots: T[] = [];
  const rootsByFolderKey = new Map<string, T[]>();
  for (const thread of roots) {
    if (input.isPinned(thread)) {
      pinnedRoots.push(thread);
      continue;
    }
    const folderKey = input.folderKeyOf(thread);
    const list = rootsByFolderKey.get(folderKey);
    if (list) list.push(thread);
    else rootsByFolderKey.set(folderKey, [thread]);
  }

  const folderKeyByThreadKey = new Map<string, string>();
  const assignFolder = (node: SidebarThreadTreeNode<T>, folderKey: string) => {
    folderKeyByThreadKey.set(node.key, folderKey);
    for (const child of node.children) assignFolder(child, folderKey);
  };

  const folders = input.projects.map((project) => {
    const key = input.projectKeyOf(project);
    const folderRoots = rootsByFolderKey.get(key);
    const nodes = folderRoots ? input.sortRoots(folderRoots).map(buildNode) : [];
    for (const node of nodes) assignFolder(node, key);
    return { key, project, nodes };
  });

  return {
    pinned: input.sortPinned(pinnedRoots).map(buildNode),
    folders,
    parentKeyByKey,
    folderKeyByThreadKey,
  };
}

export interface SidebarThreadRowEntry<T> {
  readonly node: SidebarThreadTreeNode<T>;
  readonly depth: number;
  /** Last among its siblings: its connector stops at the row's middle. */
  readonly isLastSibling: boolean;
  /**
   * For each ancestor level between the top-level row and this row's parent,
   * whether that level's connector continues past this row (the ancestor at
   * that depth has later siblings). Index 0 is depth 1.
   */
  readonly guides: readonly boolean[];
}

/** One top-level node and its expanded descendants, in render order. */
export function flattenSidebarThreadNode<T>(
  root: SidebarThreadTreeNode<T>,
  isExpanded: (key: string) => boolean,
): SidebarThreadRowEntry<T>[] {
  const rows: SidebarThreadRowEntry<T>[] = [];
  const visit = (
    node: SidebarThreadTreeNode<T>,
    depth: number,
    isLastSibling: boolean,
    guides: readonly boolean[],
  ) => {
    rows.push({ node, depth, isLastSibling, guides });
    if (node.children.length === 0 || !isExpanded(node.key)) return;
    // The connector for this node's own level continues past its subtree
    // only when it has later siblings; the top-level row draws none.
    const childGuides = depth === 0 ? guides : [...guides, !isLastSibling];
    node.children.forEach((child, index) =>
      visit(child, depth + 1, index === node.children.length - 1, childGuides),
    );
  };
  visit(root, 0, true, []);
  return rows;
}

/**
 * Keys of every rendered thread row, top to bottom: keyboard order.
 * `visibleFolderNodes` returns the top-level nodes a folder currently renders
 * (none while collapsed; a closed Settled group or a folder search hides some).
 */
export function collectVisibleSidebarThreadKeys<P, T>(
  tree: SidebarThreadTree<P, T>,
  visibleFolderNodes: (folder: SidebarProjectFolder<P, T>) => readonly SidebarThreadTreeNode<T>[],
  isThreadExpanded: (threadKey: string) => boolean,
): string[] {
  const keys: string[] = [];
  const push = (nodes: readonly SidebarThreadTreeNode<T>[]) => {
    for (const node of nodes) {
      for (const row of flattenSidebarThreadNode(node, isThreadExpanded)) keys.push(row.node.key);
    }
  };
  push(tree.pinned);
  for (const folder of tree.folders) push(visibleFolderNodes(folder));
  return keys;
}

/** Ancestors (nearest first) that must be open for `threadKey` to show. */
export function sidebarThreadAncestorKeys<P, T>(
  tree: SidebarThreadTree<P, T>,
  threadKey: string,
): string[] {
  const ancestors: string[] = [];
  let cursor = tree.parentKeyByKey.get(threadKey);
  while (cursor !== undefined) {
    ancestors.push(cursor);
    cursor = tree.parentKeyByKey.get(cursor);
  }
  return ancestors;
}

/**
 * Leads whose child agents show without a click: the open thread and its
 * ancestors, so selecting a lead or one of its agents reveals the tree, and
 * every ancestor of a thread that needs the user, so an approval or question
 * is never folded away. Everything else stays behind its lead's summary.
 */
export function sidebarAutoExpandedLeadKeys<P, T>(
  tree: SidebarThreadTree<P, T>,
  input: {
    readonly openThreadKey: string | null;
    readonly needsUser: (thread: T) => boolean;
  },
): Set<string> {
  const keys = new Set<string>();
  if (input.openThreadKey !== null) {
    keys.add(input.openThreadKey);
    for (const key of sidebarThreadAncestorKeys(tree, input.openThreadKey)) keys.add(key);
  }
  const visit = (node: SidebarThreadTreeNode<T>, ancestors: readonly string[]) => {
    if (ancestors.length > 0 && input.needsUser(node.thread)) {
      for (const key of ancestors) keys.add(key);
    }
    if (node.children.length === 0) return;
    const path = [...ancestors, node.key];
    for (const child of node.children) visit(child, path);
  };
  for (const node of tree.pinned) visit(node, []);
  for (const folder of tree.folders) for (const node of folder.nodes) visit(node, []);
  return keys;
}

export interface ThreadTreeSearchSelection {
  /** Threads to keep: every match, the path above it and the agents below it. */
  readonly keys: ReadonlySet<string>;
  /** Ancestors of a nested match, which must open for the match to show. */
  readonly expandKeys: ReadonlySet<string>;
}

/**
 * Which threads a search keeps so a match never loses its place in a tree:
 * a matching child brings its lead (and the leads above that), and a matching
 * lead brings the agents it spawned. Filter the threads by `keys` before
 * building the tree.
 */
export function selectThreadTreeSearchMatches<T>(input: {
  readonly threads: readonly T[];
  readonly threadKeyOf: (thread: T) => string;
  readonly parentKeyOf: (thread: T) => string | null;
  readonly matches: (thread: T) => boolean;
}): ThreadTreeSearchSelection {
  const parentByKey = new Map<string, string>();
  const childrenByKey = new Map<string, string[]>();
  for (const thread of input.threads) {
    const key = input.threadKeyOf(thread);
    const parentKey = input.parentKeyOf(thread);
    if (parentKey === null || parentKey === key) continue;
    parentByKey.set(key, parentKey);
    const siblings = childrenByKey.get(parentKey);
    if (siblings) siblings.push(key);
    else childrenByKey.set(parentKey, [key]);
  }

  const keys = new Set<string>();
  const expandKeys = new Set<string>();
  const addDescendants = (key: string) => {
    for (const child of childrenByKey.get(key) ?? []) {
      // `keys` doubles as the visited set, so corrupt cycles terminate.
      if (keys.has(child)) continue;
      keys.add(child);
      addDescendants(child);
    }
  };
  for (const thread of input.threads) {
    if (!input.matches(thread)) continue;
    const key = input.threadKeyOf(thread);
    keys.add(key);
    addDescendants(key);
    const seen = new Set<string>([key]);
    let cursor = parentByKey.get(key);
    while (cursor !== undefined && !seen.has(cursor)) {
      seen.add(cursor);
      keys.add(cursor);
      expandKeys.add(cursor);
      cursor = parentByKey.get(cursor);
    }
  }
  return { keys, expandKeys };
}

/**
 * Splits top-level nodes by their own state, so a settled lead takes its
 * whole agent tree with it and a working child never strands on its own.
 */
export function partitionThreadTreeNodes<T>(
  nodes: readonly SidebarThreadTreeNode<T>[],
  isSettled: (thread: T) => boolean,
): {
  readonly active: readonly SidebarThreadTreeNode<T>[];
  readonly settled: readonly SidebarThreadTreeNode<T>[];
} {
  const active: SidebarThreadTreeNode<T>[] = [];
  const settled: SidebarThreadTreeNode<T>[] = [];
  for (const node of nodes) (isSettled(node.thread) ? settled : active).push(node);
  return { active, settled };
}
