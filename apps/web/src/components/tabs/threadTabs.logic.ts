import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";

import { resolveShortcutCommand, type ShortcutEventLike } from "../../keybindings";

/** Tabs are thread keys (`scopedThreadKey`), ordered as the user opened them. */
export const MAX_OPEN_THREAD_TABS = 24;

/** Opening an already-open thread only activates it; a new one lands right of the active tab. */
export function openThreadTab(
  tabs: ReadonlyArray<string>,
  threadKey: string,
  afterKey: string | null = null,
): ReadonlyArray<string> {
  if (tabs.includes(threadKey)) return tabs;
  const anchor = afterKey === null ? -1 : tabs.indexOf(afterKey);
  const next =
    anchor === -1
      ? [...tabs, threadKey]
      : [...tabs.slice(0, anchor + 1), threadKey, ...tabs.slice(anchor + 1)];
  // Past the cap the oldest tabs fall off, never the one just opened.
  const excess = next.length - MAX_OPEN_THREAD_TABS;
  return excess > 0 ? next.filter((key, index) => key === threadKey || index >= excess) : next;
}

export function closeThreadTab(
  tabs: ReadonlyArray<string>,
  threadKey: string,
  activeKey: string | null,
): { tabs: ReadonlyArray<string>; nextActiveKey: string | null } {
  const index = tabs.indexOf(threadKey);
  if (index === -1) return { tabs, nextActiveKey: activeKey };
  const next = tabs.filter((key) => key !== threadKey);
  if (activeKey !== threadKey) return { tabs: next, nextActiveKey: activeKey };
  // Closing the active tab lands on its right neighbour, else the left one.
  return { tabs: next, nextActiveKey: next[index] ?? next[index - 1] ?? null };
}

/** Next/previous tab with wrap-around; null when there is nowhere else to go. */
export function adjacentThreadTab(
  tabs: ReadonlyArray<string>,
  activeKey: string | null,
  direction: "next" | "previous",
): string | null {
  if (tabs.length < 2) return null;
  const index = activeKey === null ? -1 : tabs.indexOf(activeKey);
  if (index === -1) return tabs[direction === "next" ? 0 : tabs.length - 1] ?? null;
  const step = direction === "next" ? 1 : tabs.length - 1;
  return tabs[(index + step) % tabs.length] ?? null;
}

/** Most-recently-used first: `visited` moves to the front, duplicates collapse. */
export function touchRecentView(
  recent: ReadonlyArray<string>,
  visited: string,
  limit = 32,
): ReadonlyArray<string> {
  if (recent[0] === visited) return recent;
  return [visited, ...recent.filter((key) => key !== visited)].slice(0, limit);
}

/** Rows the Ctrl-Tab overlay shows; stepping never goes past what is visible. */
export const MAX_RECENT_VIEW_CANDIDATES = 9;

/** What the Ctrl-Tab overlay lists: recent threads that still exist, current one first. */
export function recentViewCandidates(
  recent: ReadonlyArray<string>,
  exists: (key: string) => boolean,
): ReadonlyArray<string> {
  return recent.filter(exists).slice(0, MAX_RECENT_VIEW_CANDIDATES);
}

/**
 * Drops tabs whose thread is gone, but only in environments whose live thread
 * list has loaded: a remote environment that is offline or still connecting
 * keeps its tabs. Returns the input when nothing changes.
 */
export function pruneThreadTabs(
  tabsByEnvironmentId: Record<string, ReadonlyArray<string>>,
  loadedEnvironmentIds: ReadonlySet<string>,
  keep: (threadKey: string) => boolean,
): Record<string, ReadonlyArray<string>> {
  let next = tabsByEnvironmentId;
  for (const [environmentId, tabs] of Object.entries(tabsByEnvironmentId)) {
    if (!loadedEnvironmentIds.has(environmentId)) continue;
    const kept = tabs.filter(keep);
    if (kept.length === tabs.length) continue;
    if (next === tabsByEnvironmentId) next = { ...tabsByEnvironmentId };
    next[environmentId] = kept;
  }
  return next;
}

/** Each Tab press steps one entry deeper (shift goes back); the first press lands on the previous thread. */
export function stepRecentSelection(
  length: number,
  selectedIndex: number,
  direction: "forward" | "backward",
): number {
  if (length === 0) return 0;
  const step = direction === "forward" ? 1 : length - 1;
  return (selectedIndex + step) % length;
}

export type ThreadTabCommand = "tab.next" | "tab.previous" | "tab.close";

/**
 * The tab command a key press resolves to, honouring `when` clauses against the
 * focus context (so `!terminalFocus` keeps `mod+alt+w` inside the terminal).
 */
export function resolveThreadTabCommand(
  event: ShortcutEventLike,
  keybindings: ResolvedKeybindingsConfig,
  options: Parameters<typeof resolveShortcutCommand>[2],
): ThreadTabCommand | null {
  const command = resolveShortcutCommand(event, keybindings, options);
  return command === "tab.next" || command === "tab.previous" || command === "tab.close"
    ? command
    : null;
}
