import { describe, expect, it } from "vite-plus/test";

import { sortActiveThreadsByOrderKey } from "./threadSort.ts";

// ViewCode guards (0e67a01eb, 0ef5e5d81): upstream's active-thread sort anchors on
// ViewCode's activity rule, so the chat the user messaged last leads the list on web and
// mobile, while an agent's update alone does not move a thread past one the user arranged.
describe("active thread order (ViewCode)", () => {
  it("leads with the thread the user messaged last, not the newest created", () => {
    const sorted = sortActiveThreadsByOrderKey([
      {
        id: "newer-idle",
        createdAt: "2026-10-12T10:36:45.558Z",
        latestUserMessageAt: "2026-10-12T10:36:45.558Z",
      },
      {
        id: "older-in-use",
        createdAt: "2026-10-11T11:55:49.402Z",
        latestUserMessageAt: "2026-10-13T06:57:04.195Z",
      },
    ]);
    expect(sorted.map((thread) => thread.id)).toEqual(["older-in-use", "newer-idle"]);
  });

  it("keeps saved order stable while user messages and agent updates arrive", () => {
    const threads = [
      {
        id: "manual-first",
        activeOrderKey: "a",
        createdAt: "2026-10-01T00:00:00Z",
        latestUserMessageAt: null,
      },
      {
        id: "manual-second",
        activeOrderKey: "z",
        createdAt: "2026-10-02T00:00:00Z",
        latestUserMessageAt: "2026-10-18T00:00:00Z",
      },
      {
        id: "agent-updated",
        activeOrderKey: null,
        createdAt: "2026-10-01T00:00:00Z",
        latestUserMessageAt: "invalid",
        updatedAt: "2026-10-19T00:00:00Z",
      },
      {
        id: "user-updated",
        activeOrderKey: null,
        createdAt: "2026-10-01T00:00:00Z",
        latestUserMessageAt: "2026-10-17T00:00:00Z",
      },
    ];
    expect(sortActiveThreadsByOrderKey(threads).map(({ id }) => id)).toEqual([
      "user-updated",
      "agent-updated",
      "manual-first",
      "manual-second",
    ]);
  });
});
