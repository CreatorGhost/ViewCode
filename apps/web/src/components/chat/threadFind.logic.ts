import type { TimelineEntry } from "../../session-logic";

/** One hit: the timeline entry holding it and which occurrence it is within that entry. */
export interface ThreadFindMatch {
  readonly entryId: string;
  readonly messageId: string;
  readonly occurrence: number;
}

/**
 * Case-insensitive, non-overlapping matches of `query` across the user and
 * assistant messages of a thread, in transcript order. Works on client state
 * rather than the DOM, so it also finds text in rows the virtualised list has
 * not mounted.
 */
export function findThreadMatches(
  entries: ReadonlyArray<TimelineEntry>,
  query: string,
): ThreadFindMatch[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const matches: ThreadFindMatch[] = [];
  for (const entry of entries) {
    if (entry.kind !== "message") continue;
    const { role, text, id } = entry.message;
    if (role !== "user" && role !== "assistant") continue;
    const haystack = text.toLowerCase();
    let occurrence = 0;
    for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length)) {
      matches.push({ entryId: entry.id, messageId: id, occurrence: occurrence++ });
    }
  }
  return matches;
}

/** Wraps around; -1 when there is nothing to step through. */
export function stepFindIndex(count: number, current: number, direction: 1 | -1): number {
  if (count <= 0) return -1;
  if (current < 0 || current >= count) return direction === 1 ? 0 : count - 1;
  return (current + direction + count) % count;
}

/** Text ranges of `query` inside `root`'s rendered text, in document order. */
export function collectTextRanges(root: Element, query: string): Range[] {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return [];
  const ranges: Range[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const haystack = (node.nodeValue ?? "").toLowerCase();
    for (let from = haystack.indexOf(needle); from >= 0; from = haystack.indexOf(needle, from + needle.length)) {
      const range = root.ownerDocument.createRange();
      range.setStart(node, from);
      range.setEnd(node, from + needle.length);
      ranges.push(range);
    }
  }
  return ranges;
}

/**
 * Cmd/Ctrl-F belongs to the chat only when the focus is not inside something
 * that has its own find: the terminal, a code editor or the diff viewer.
 */
export function chatOwnsFindShortcut(target: EventTarget | null, terminalFocus: boolean): boolean {
  if (terminalFocus) return false;
  if (!(target instanceof Element)) return true;
  return target.closest("[data-right-panel-surface-content], .cm-editor, [data-diffs-container]") === null;
}
