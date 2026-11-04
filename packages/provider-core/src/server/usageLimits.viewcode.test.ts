import { describe, expect, it } from "vite-plus/test";

import { resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session" as const,
  label: "Session",
  usedPercent: 40,
  resetsAt: "2026-09-03T15:00:00.000Z",
};
const published = { checkedAt, windows: [session] };

// ViewCode keeps published bars through an empty successful read, but not past their
// reset: a "limit reached" bar whose window has rolled over would otherwise stay up.
describe("resolveUsageLimitsAfterProbe kept windows", () => {
  it("drops a kept window whose reset has passed, and all of them once none is live", () => {
    const empty = { checkedAt: "2026-09-03T12:10:00.000Z", windows: [] };
    const past = { ...published.windows[0]!, id: "past", resetsAt: "2026-09-03T12:00:00.000Z" };
    const future = { ...published.windows[0]!, id: "future", resetsAt: "2026-09-04T12:00:00.000Z" };
    expect(
      resolveUsageLimitsAfterProbe({
        published: { ...published, windows: [past, future] },
        probed: empty,
      })?.windows,
    ).toEqual([future]);
    expect(
      resolveUsageLimitsAfterProbe({ published: { ...published, windows: [past] }, probed: empty }),
    ).toBe(empty);
  });
});
