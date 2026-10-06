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
  if (typeof CSS === "undefined" || !("highlights" in CSS) || typeof Highlight === "undefined") return;
  CSS.highlights.set(HIGHLIGHT, new Highlight(...all));
  if (active) CSS.highlights.set(HIGHLIGHT_ACTIVE, new Highlight(active));
  else CSS.highlights.delete(HIGHLIGHT_ACTIVE);
}

const clearHighlights = () => setHighlights([], null);

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

/**
 * Find in thread. Matches are computed from client state; for the active one
 * the virtualised row is scrolled into view, then the rendered text of the
 * mounted rows is highlighted through the CSS Custom Highlight API.
 */
export function ThreadFindBar({
  entries,
  listRef,
  getViewport,
  onClose,
}: {
  entries: ReadonlyArray<TimelineEntry>;
  listRef: RefObject<LegendListRef | null>;
  getViewport: () => HTMLElement | null;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(-1);
  const inputRef = useRef<HTMLInputElement>(null);
  const matches = useMemo(() => findThreadMatches(entries, query), [entries, query]);
  const current = matches.length === 0 ? -1 : Math.min(Math.max(index, 0), matches.length - 1);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return clearHighlights;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const active: ThreadFindMatch | undefined = matches[current];
    void (async () => {
      const list = listRef.current;
      const viewport = getViewport();
      if (!viewport || matches.length === 0) return clearHighlights();
      if (active) {
        const rowIndex = list?.getState().indexByKey(active.entryId);
        const row = () =>
          viewport.querySelector(`[data-message-id="${CSS.escape(active.messageId)}"]`);
        if (rowIndex !== undefined && row() === null) {
          await list?.scrollToIndex({ index: rowIndex, animated: false, viewOffset: 80 });
          // The row mounts and measures over a couple of frames.
          for (let frame = 0; frame < 4 && row() === null; frame++) await nextFrame();
        }
        row()?.scrollIntoView({ block: "center" });
      }
      if (cancelled) return;
      const all = collectTextRanges(viewport, query);
      const inMessage = active
        ? collectTextRanges(
            viewport.querySelector(`[data-message-id="${CSS.escape(active.messageId)}"]`) ?? viewport,
            query,
          )
        : [];
      // Source text and rendered text can differ (markdown syntax), so clamp.
      const activeRange = active ? (inMessage[Math.min(active.occurrence, inMessage.length - 1)] ?? null) : null;
      setHighlights(all, activeRange);
      activeRange?.startContainer.parentElement?.scrollIntoView({ block: "nearest" });
    })();
    return () => {
      cancelled = true;
    };
  }, [matches, current, query, listRef, getViewport]);

  const step = (direction: 1 | -1) => setIndex(stepFindIndex(matches.length, current, direction));

  return (
    <div
      role="search"
      className="absolute top-2 right-4 z-30 flex items-center gap-1 rounded-lg border border-border bg-popover p-1 shadow-lg"
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
        {query.trim() === "" ? "" : matches.length === 0 ? "No results" : `${current + 1}/${matches.length}`}
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
