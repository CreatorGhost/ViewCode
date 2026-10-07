import { describe, expect, it } from "vite-plus/test";

import { threadCountLabel, threadStatusLabel } from "./sidebarHoverCard.logic";

describe("sidebar hover card labels", () => {
  it("names each thread status", () => {
    expect(threadStatusLabel("working")).toBe("Working");
    expect(threadStatusLabel("ready")).toBe("Idle");
  });
  it("pluralizes thread counts", () => {
    expect([0, 1, 2].map(threadCountLabel)).toEqual(["0 threads", "1 thread", "2 threads"]);
  });
});
