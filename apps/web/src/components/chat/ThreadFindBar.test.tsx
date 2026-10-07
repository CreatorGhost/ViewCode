import type { LegendListRef } from "@legendapp/list/react";
import { act, type RefObject } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { THREAD_FIND_REFRESH_MS, ThreadFindBar } from "./ThreadFindBar";

const message = (id: string, role: "user" | "assistant", text: string) =>
  ({
    id: `entry-${id}`,
    kind: "message",
    createdAt: "",
    message: { id, role, text },
  }) as unknown as TimelineEntry;

// A stand-in for the timeline viewport: every row is mounted, and each text walk is counted.
const createTreeWalker = vi.fn(() => ({ nextNode: () => null }));
const ownerDocument = { createTreeWalker, createRange: vi.fn() };
const row = { ownerDocument, scrollIntoView: vi.fn() };
const viewport = { ownerDocument, querySelector: vi.fn(() => row) };
const listRef = {
  current: { getState: () => ({ indexByKey: () => 0 }), scrollToIndex: vi.fn() },
} as unknown as RefObject<LegendListRef | null>;
const getViewport = () => viewport as unknown as HTMLElement;

let renderer: ReactTestRenderer | null = null;

function render(entries: ReadonlyArray<TimelineEntry>) {
  const element = (
    <ThreadFindBar
      entries={entries}
      listRef={listRef}
      getViewport={getViewport}
      onClose={() => {}}
    />
  );
  act(() => {
    if (renderer) renderer.update(element);
    else renderer = create(element);
  });
}

async function flush() {
  await act(async () => {});
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("NodeFilter", { SHOW_TEXT: 4 });
  createTreeWalker.mockClear();
  row.scrollIntoView.mockClear();
});

afterEach(() => {
  act(() => renderer?.unmount());
  renderer = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("ThreadFindBar while a reply streams", () => {
  it("keeps the scroll position and throttles the highlight refresh", async () => {
    const question = message("q", "user", "where is the needle? the needle again");
    let reply = "Looking";
    render([question, message("r", "assistant", reply)]);

    act(() => {
      renderer!.root.findByProps({ "aria-label": "Find in thread" }).props.onChange({
        target: { value: "needle" },
      });
    });
    await flush();
    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    const walksAfterSearch = createTreeWalker.mock.calls.length;

    // Ten tokens over 200ms: each one is a new entries array.
    for (let token = 0; token < 10; token++) {
      reply += " more";
      render([question, message("r", "assistant", reply)]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20);
      });
    }
    await act(async () => {
      await vi.advanceTimersByTimeAsync(THREAD_FIND_REFRESH_MS);
    });

    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    // At most a leading and a trailing refresh, each walking the viewport and the active row.
    expect(createTreeWalker.mock.calls.length - walksAfterSearch).toBeLessThanOrEqual(4);

    // Moving to the next match still scrolls to it.
    act(() => {
      renderer!.root.findByProps({ "aria-label": "Next match" }).props.onClick();
    });
    await flush();
    expect(row.scrollIntoView).toHaveBeenCalledTimes(2);
  });
});
