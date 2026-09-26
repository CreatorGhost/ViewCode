import { describe, expect, it } from "vite-plus/test";

import { ABRUPT_EXIT_WINDOW_MS, makeAbruptExitTracker } from "./backendRestartCap.ts";

describe("makeAbruptExitTracker", () => {
  it("gives up on the third abrupt exit within the window", () => {
    const tracker = makeAbruptExitTracker();
    expect(tracker.record(0)).toBe(false);
    expect(tracker.record(10_000)).toBe(false);
    expect(tracker.record(20_000)).toBe(true);
  });

  it("forgets exits older than the window", () => {
    const tracker = makeAbruptExitTracker();
    expect(tracker.record(0)).toBe(false);
    expect(tracker.record(1_000)).toBe(false);
    expect(tracker.record(ABRUPT_EXIT_WINDOW_MS + 2_000)).toBe(false);
  });
});
