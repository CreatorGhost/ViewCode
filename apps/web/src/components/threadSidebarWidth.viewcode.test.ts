import { describe, expect, it } from "vite-plus/test";

import {
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_OVERLAY_BREAKPOINT,
  threadLayoutWidth,
} from "./threadSidebarWidth";

// ViewCode's AppRail sits left of the thread sidebar, so the sidebar's limits count it.
describe("thread sidebar width beside the app rail", () => {
  it("leaves the main column its minimum after the rail and the sidebar", () => {
    expect(resolveThreadSidebarMaximumWidth(threadLayoutWidth(1280))).toBe(1280 - 48 - 640);
  });

  it("reaches the sidebar minimum exactly at the overlay breakpoint", () => {
    expect(THREAD_SIDEBAR_OVERLAY_BREAKPOINT).toBe(896);
    expect(
      resolveThreadSidebarMaximumWidth(threadLayoutWidth(THREAD_SIDEBAR_OVERLAY_BREAKPOINT)),
    ).toBe(THREAD_SIDEBAR_MIN_WIDTH);
  });

  it("clamps a stored or default width that would squeeze the main column", () => {
    expect(resolveInitialThreadSidebarWidth(300, threadLayoutWidth(1280))).toBe(300);
    expect(resolveInitialThreadSidebarWidth(600, threadLayoutWidth(1000))).toBe(1000 - 48 - 640);
    expect(resolveInitialThreadSidebarWidth(null, threadLayoutWidth(900))).toBe(900 - 48 - 640);
  });
});
