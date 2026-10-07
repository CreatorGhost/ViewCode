import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSplitPair,
  clampSplitRatio,
  isSplitPaneThreadGone,
  parsePersistedSplit,
  pickSplitCompanion,
  remainingAfterClose,
  resolveFocusedPane,
  swapSplitPair,
} from "./splitView.logic";

const ref = (id: string) => scopeThreadRef(EnvironmentId.make("env"), ThreadId.make(id));

describe("split view logic", () => {
  it("opens a pair only for two different threads", () => {
    expect(buildSplitPair(ref("a"), ref("b"))).toEqual([ref("a"), ref("b")]);
    expect(buildSplitPair(ref("a"), ref("a"))).toBeNull();
    expect(buildSplitPair(null, ref("b"))).toBeNull();
  });

  it("swaps panes and reports what remains after a close", () => {
    const pair = [ref("a"), ref("b")] as const;
    expect(swapSplitPair(pair)).toEqual([ref("b"), ref("a")]);
    expect(remainingAfterClose(pair, 0)).toEqual(ref("b"));
    expect(remainingAfterClose(pair, 1)).toEqual(ref("a"));
  });

  it("derives the focused pane from the route thread", () => {
    const pair = [ref("a"), ref("b")] as const;
    expect(resolveFocusedPane(pair, "env:a")).toBe(0);
    expect(resolveFocusedPane(pair, "env:b")).toBe(1);
    expect(resolveFocusedPane(pair, "env:zzz")).toBeNull();
    expect(resolveFocusedPane(null, "env:a")).toBeNull();
    expect(resolveFocusedPane(pair, null)).toBeNull();
  });

  it("clamps the ratio so both panes keep their minimum width", () => {
    expect(clampSplitRatio(0.05, 1200)).toBeCloseTo(0.3);
    expect(clampSplitRatio(0.95, 1200)).toBeCloseTo(0.7);
    expect(clampSplitRatio(0.4, 1200)).toBe(0.4);
    expect(clampSplitRatio(0.9, 600)).toBe(0.5);
    expect(clampSplitRatio(Number.NaN, 1200)).toBe(0.5);
  });

  it("picks the newest other unarchived thread", () => {
    const threads = [
      { environmentId: "env", id: "a", archivedAt: null },
      { environmentId: "env", id: "b", archivedAt: "x" },
      { environmentId: "env", id: "c", archivedAt: null },
    ];
    expect(pickSplitCompanion(threads, ref("a"))?.id).toBe("c");
    expect(pickSplitCompanion(threads.slice(0, 1), ref("a"))).toBeNull();
  });

  it("never pairs a side chat", () => {
    const threads = [
      { environmentId: "env", id: "side", archivedAt: null, kind: "sidechat" },
      { environmentId: "env", id: "c", archivedAt: null, kind: null },
    ];
    expect(pickSplitCompanion(threads, ref("a"))?.id).toBe("c");
  });

  it("treats a pane as gone only when absence is proven", () => {
    const loaded = {
      shellExists: true,
      detailExists: true,
      archived: false,
      deleted: false,
      environmentLive: true,
    };
    expect(isSplitPaneThreadGone(loaded)).toBe(false);
    expect(isSplitPaneThreadGone({ ...loaded, archived: true })).toBe(true);
    expect(isSplitPaneThreadGone({ ...loaded, deleted: true })).toBe(true);
    const missing = { ...loaded, shellExists: false, detailExists: false };
    expect(isSplitPaneThreadGone(missing)).toBe(true);
    // Still connecting, or the environment was removed: wait instead of closing.
    expect(isSplitPaneThreadGone({ ...missing, environmentLive: false })).toBe(false);
  });

  it("parses persisted state defensively", () => {
    expect(parsePersistedSplit(null)).toEqual({ pair: null, ratio: 0.5 });
    expect(
      parsePersistedSplit({ pair: [{ environmentId: "e", threadId: "t" }], ratio: 2 }),
    ).toEqual({ pair: null, ratio: 0.5 });
    const good = parsePersistedSplit({
      pair: [
        { environmentId: "e", threadId: "t1" },
        { environmentId: "e", threadId: "t2" },
      ],
      ratio: 0.4,
    });
    expect(good.ratio).toBe(0.4);
    expect(good.pair?.[1].threadId).toBe("t2");
  });
});
