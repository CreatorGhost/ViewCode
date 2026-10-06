import { describe, expect, it } from "vite-plus/test";

import {
  adjacentThreadTab,
  closeThreadTab,
  MAX_OPEN_THREAD_TABS,
  openThreadTab,
  recentViewCandidates,
  stepRecentSelection,
  touchRecentView,
} from "./threadTabs.logic";

describe("open and close", () => {
  it("opens next to the active tab and never duplicates", () => {
    expect(openThreadTab(["a", "b", "c"], "x", "a")).toEqual(["a", "x", "b", "c"]);
    expect(openThreadTab(["a", "b"], "b", "a")).toEqual(["a", "b"]);
    expect(openThreadTab(["a"], "x", null)).toEqual(["a", "x"]);
  });

  it("drops the oldest tab past the cap", () => {
    const full = Array.from({ length: MAX_OPEN_THREAD_TABS }, (_, i) => `t${i}`);
    const next = openThreadTab(full, "new", null);
    expect(next).toHaveLength(MAX_OPEN_THREAD_TABS);
    expect(next).not.toContain("t0");
    expect(next.at(-1)).toBe("new");
  });

  it("activates the right neighbour, then the left, when the active tab closes", () => {
    expect(closeThreadTab(["a", "b", "c"], "b", "b")).toEqual({
      tabs: ["a", "c"],
      nextActiveKey: "c",
    });
    expect(closeThreadTab(["a", "b"], "b", "b")).toEqual({ tabs: ["a"], nextActiveKey: "a" });
    expect(closeThreadTab(["a"], "a", "a")).toEqual({ tabs: [], nextActiveKey: null });
    expect(closeThreadTab(["a", "b"], "a", "b")).toEqual({ tabs: ["b"], nextActiveKey: "b" });
  });
});

describe("adjacentThreadTab", () => {
  it("wraps both ways and needs two tabs", () => {
    expect(adjacentThreadTab(["a", "b", "c"], "c", "next")).toBe("a");
    expect(adjacentThreadTab(["a", "b", "c"], "a", "previous")).toBe("c");
    expect(adjacentThreadTab(["a"], "a", "next")).toBeNull();
    expect(adjacentThreadTab(["a", "b"], null, "next")).toBe("a");
  });
});

describe("recent views", () => {
  it("keeps most recent first and collapses repeats", () => {
    expect(touchRecentView(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(touchRecentView(["a"], "a")).toEqual(["a"]);
  });

  it("lists only threads that still exist", () => {
    expect(recentViewCandidates(["a", "gone", "b"], (key) => key !== "gone")).toEqual(["a", "b"]);
  });

  it("steps through the list with wrap-around", () => {
    expect(stepRecentSelection(3, 0, "forward")).toBe(1);
    expect(stepRecentSelection(3, 2, "forward")).toBe(0);
    expect(stepRecentSelection(3, 0, "backward")).toBe(2);
    expect(stepRecentSelection(0, 0, "forward")).toBe(0);
  });
});
