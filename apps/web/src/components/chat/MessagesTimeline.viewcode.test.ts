// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const timeline = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "MessagesTimeline.tsx"),
  "utf8",
);

// The draw distance is a single prop on upstream's list. A merge that takes
// upstream's copy drops it with no conflict, and the timeline goes back to
// scrolling into blank space whenever agents keep the main thread busy.
describe("ViewCode timeline virtualization", () => {
  it("draws about a viewport of rows beyond the visible ones", () => {
    expect(timeline).toContain("drawDistance={TIMELINE_DRAW_DISTANCE}");
    const drawDistance = Number(timeline.match(/const TIMELINE_DRAW_DISTANCE = (\d+);/)?.[1]);
    expect(drawDistance).toBeGreaterThanOrEqual(1000);
  });
});
