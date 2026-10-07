import type { LegendListRef } from "@legendapp/list/react";
import { ChevronDownIcon, ChevronUpIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type RefObject } from "react";

import type { TimelineEntry } from "../../session-logic";
import { Button } from "../ui/button";
import {
  collectTextRanges,
  findThreadMatches,
  stepFindIndex,
  type ThreadFindMatch,
} from "./threadFind.logic";

/** Fired by the command palette; ChatView opens its find bar. */
export const THREAD_FIND_OPEN_EVENT = "viewcode:thread-find-open";

const HIGHLIGHT = "viewcode-find";
const HIGHLIGHT_ACTIVE = "viewcode-find-active";

function setHighlights(all: Range[], active: Range | null) {
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined")
    return;
  CSS.highlights.set(HIGHLIGHT, new Highlight(...all));
  if (active) CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(active));
  else CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

const clearHighlights = () => setHighlights([], null);

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/** How often streamed output may re-run the search and repaint the highlights. */
export const THREAD_FIND_REFRESH_MS = 250;

/**
 * `value`, updated at most once per `intervalMs` (leading and trailing), so a
 * transcript that changes per streamed token is searched a few times a second.
 */
function useThrottledValue<T>(value: T, intervalMs: number): T {
  const [throttled, setThrottled] = useState(value);
  const committedAtRef = useRef(0);
  useEffect(() => {
    if (Object.is(value, throttled)) return;
    const commit = () => {
      committedAtRef.current = Date.now();
      setThrottled(value);
    };
    const wait = committedAtRef.current + intervalMs - Date.now();
    if (wait <= 0) {
      commit();
      return;
    }
    const timer = setTimeout(commit, wait);
    return () => clearTimeout(timer);
  }, [intervalMs, throttled, value]);
  return throttled;
}

/**
 * Find in thread. Matches are computed from client state; for the active one
 * the virtualised row is scrolled into view, then the rendered text of the
 * mounted rows is highlighted through the CSS Custom Highlight API. While a
 * reply streams, the search and highlights refresh on a throttle and the
 * scroll position is only moved when the active match itself changes.
 */
export function ThreadFindBar({
  entries,
  listRef,
  getViewport,
  focusRequest = 0,
  onClose,
}: {
  entries: ReadonlyArray<TimelineEntry>;
  listRef: RefObject<LegendListRef | null>;
  getViewport: () => HTMLElement | null;
  /** Bump to refocus and select the input (the find shortcut while the bar is already open). */
  focusRequest?: number;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const searchedEntries = useThrottledValue(entries, THREAD_FIND_REFRESH_MS);
  const matches = useMemo(
    () => findThreadMatches(searchedEntries, query),
    [searchedEntries, query],
  );
  const current = matches.length === 0 ? -1 : Math.min(Math.max(index, 0), matches.length - 1);
  const active: ThreadFindMatch | undefined = matches[current];
  const activeEntryId = active?.entryId ?? null;
  const activeMessageId = active?.messageId ?? null;
  const activeOccurrence = active?.occurrence ?? -1;
  // The match last scrolled to; new matches from streamed text leave it alone.
  const scrolledKeyRef = useRef<string | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusRequest]);
  useEffect(() => clearHighlights, []);

  useEffect(() => {
    let cancelled = false;
    let settled = false;
    const activeKey =
      activeEntryId === null ? null : `${query}\u0000${activeEntryId}\u0000${activeOccurrence}`;
    const shouldScroll = activeKey !== null && activeKey !== scrolledKeyRef.current;
    scrolledKeyRef.current = activeKey;
    void (async () => {
      const list = listRef.current;
      const viewport = getViewport();
      if (!viewport || matches.length === 0) return clearHighlights();
      const row = () =>
        activeMessageId === null
          ? null
          : viewport.querySelector(`[data-message-id="${CSS.escape(activeMessageId)}"]`);
      if (shouldScroll && activeEntryId !== null) {
        const rowIndex = list?.getState().indexByKey(activeEntryId);
        if (rowIndex !== undefined && row() === null) {
          await list?.scrollToIndex({ index: rowIndex, animated: false, viewOffset: 80 });
          // The row mounts and measures over a couple of frames.
          for (let frame = 0; frame < 4 && row() === null; frame++) await nextFrame();
        }
        row()?.scrollIntoView({ block: "center" });
      }
      if (cancelled) return;
      const all = collectTextRanges(viewport, query);
      const activeRow = row();
      const inMessage = activeRow ? collectTextRanges(activeRow, query) : [];
      // Source text and rendered text can differ (markdown syntax), so clamp.
      const activeRange =
        activeOccurrence >= 0
          ? (inMessage[Math.min(activeOccurrence, inMessage.length - 1)] ?? null)
          : null;
      setHighlights(all, activeRange);
      settled = true;
      if (shouldScroll)
        activeRange?.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
    })();
    return () => {
      cancelled = true;
      // Superseded before landing: let the next run scroll to the match again.
      if (shouldScroll && !settled) scrolledKeyRef.current = null;
    };
  }, [matches, activeEntryId, activeMessageId, activeOccurrence, query, listRef, getViewport]);

  const step = (direction: 1 | -1) => setIndex(stepFindIndex(matches.length, current, direction));

  return (
    <div
      role="search"
      className="absolute top-2 right-6 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
    >
      <input
        ref={inputRef}
        value={query}
        placeholder="Find in thread"
        aria-label="Find in thread"
        className="h-7 w-48 bg-transparent px-2 text-sm outline-none placeholder:text-placeholder"
        onChange={(event) => {
          setQuery(event.target.value);
          setIndex(0);
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          } else if (event.key === "Enter") {
            event.preventDefault();
            step(event.shiftKey ? -1 : 1);
          }
        }}
      />
      <span className="min-w-12 text-center text-muted-foreground text-xs tabular-nums">
        {query.trim() === ""
          ? ""
          : matches.length === 0
            ? "No results"
            : `${current + 1}/${matches.length}`}
      </span>
      <Button size="icon-xs" variant="ghost" aria-label="Previous match" onClick={() => step(-1)}>
        <ChevronUpIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Next match" onClick={() => step(1)}>
        <ChevronDownIcon />
      </Button>
      <Button size="icon-xs" variant="ghost" aria-label="Close find" onClick={onClose}>
        <XIcon />
      </Button>
    </div>
  );
}
