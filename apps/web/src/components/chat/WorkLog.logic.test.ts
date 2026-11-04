import { describe, expect, it } from "vite-plus/test";

import {
  advanceChipArrivals,
  BRANCH_OFFSET,
  initialChipArrivals,
  RAIL_X,
  workLogRailSegments,
} from "./WorkLog.logic";

const row = { markerY: 14, clearance: 6 };

describe("workLogRailSegments", () => {
  it("draws nothing for a step with no neighbours", () => {
    expect(
      workLogRailSegments({ ...row, ends: { above: false, below: false }, lane: "main" }),
    ).toEqual([]);
  });

  it("starts the rail below the first marker and ends it above the last, clear of both", () => {
    expect(
      workLogRailSegments({ ...row, ends: { above: false, below: true }, lane: "main" }),
    ).toEqual([{ part: "below", shape: "line", left: RAIL_X, top: 20, height: null }]);
    expect(
      workLogRailSegments({ ...row, ends: { above: true, below: false }, lane: "main" }),
    ).toEqual([{ part: "above", shape: "line", left: RAIL_X, top: 0, height: 8 }]);
  });

  it("leaves a gap around a middle step's marker", () => {
    expect(
      workLogRailSegments({ ...row, ends: { above: true, below: true }, lane: "main" }).map(
        ({ part, top, height }) => [part, top, height],
      ),
    ).toEqual([
      ["above", 0, 8],
      ["below", 20, null],
    ]);
  });

  it("passes the main rail by a branch and curves the branch off it", () => {
    expect(
      workLogRailSegments({ ...row, ends: { above: true, below: true }, lane: "branch-start" }),
    ).toEqual([
      { part: "main", shape: "line", left: RAIL_X, top: 0, height: null },
      { part: "above", shape: "curve", left: RAIL_X, top: 0, height: 8 },
    ]);
    expect(
      workLogRailSegments({ ...row, ends: { above: true, below: false }, lane: "branch" }),
    ).toEqual([
      { part: "main", shape: "line", left: RAIL_X, top: 0, height: 14 },
      { part: "above", shape: "line", left: RAIL_X + BRANCH_OFFSET, top: 0, height: 8 },
    ]);
  });
});

describe("chip arrivals", () => {
  it("staggers in every chip of a step that mounts live, and none of a finished one", () => {
    expect(initialChipArrivals(["a", "b"], true).fresh).toEqual(["a", "b"]);
    expect(initialChipArrivals(["a", "b"], false).fresh).toEqual([]);
  });

  it("staggers only the chips that arrive after mount, in arrival order", () => {
    const mounted = initialChipArrivals(["a"], true);
    const next = advanceChipArrivals(mounted, ["a", "b", "c"], true);
    expect(next.fresh).toEqual(["b", "c"]);
    expect(advanceChipArrivals(next, ["a", "b", "c"], true)).toBe(next);
  });

  it("keeps chips still once the step has finished", () => {
    const mounted = initialChipArrivals(["a"], true);
    expect(advanceChipArrivals(mounted, ["a", "b"], false).fresh).toEqual([]);
  });
});
