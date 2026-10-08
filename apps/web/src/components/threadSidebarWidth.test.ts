import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_OVERLAY_BREAKPOINT,
} from "./threadSidebarWidth";

describe("resolveThreadSidebarMaximumWidth", () => {
  it("leaves the main column its minimum after the rail and the sidebar", () => {
    expect(resolveThreadSidebarMaximumWidth(1280)).toBe(1280 - 48 - 640);
  });

  it("reaches the sidebar minimum exactly at the overlay breakpoint", () => {
    expect(THREAD_SIDEBAR_OVERLAY_BREAKPOINT).toBe(896);
    expect(resolveThreadSidebarMaximumWidth(THREAD_SIDEBAR_OVERLAY_BREAKPOINT)).toBe(
      THREAD_SIDEBAR_MIN_WIDTH,
    );
    expect(resolveThreadSidebarMaximumWidth(500)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });
});

describe("resolveInitialThreadSidebarWidth", () => {
  it("keeps a stored width that fits and clamps one that does not", () => {
    expect(resolveInitialThreadSidebarWidth(300, 1280)).toBe(300);
    expect(resolveInitialThreadSidebarWidth(600, 1000)).toBe(1000 - 48 - 640);
    expect(resolveInitialThreadSidebarWidth(100, 1280)).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("clamps the default width on a narrow window", () => {
    expect(resolveInitialThreadSidebarWidth(null, 1280)).toBe(256);
    expect(resolveInitialThreadSidebarWidth(null, 900)).toBe(900 - 48 - 640);
  });
});
