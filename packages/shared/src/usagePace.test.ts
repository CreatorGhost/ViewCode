import { describe, expect, it } from "vitest";

import { railPlanLabel, usagePace } from "./usagePace.ts";

const resetsAt = new Date(Date.UTC(2026, 0, 8)).toISOString();
const now = Date.UTC(2026, 0, 4);
const base = { resetsAt, windowDurationMins: 7 * 24 * 60, now };

describe("usagePace", () => {
  it("reports reserve when under the even pace", () => {
    const pace = usagePace({ ...base, remainingPercent: 80 });
    expect(pace?.status).toBe("ahead");
    expect(pace?.amount).toBe("23% in reserve");
    expect(pace?.eta).toBe("Lasts until reset");
  });

  it("reports deficit and a run-out time when ahead of the even pace", () => {
    const pace = usagePace({ ...base, remainingPercent: 10 });
    expect(pace?.status).toBe("behind");
    expect(pace?.amount).toBe("47% in deficit");
    expect(pace?.eta).toMatch(/^Runs out in /);
  });

  it("reports the limit reached at 0% left", () => {
    expect(usagePace({ ...base, remainingPercent: 0 })?.eta).toBe("Limit reached");
  });

  it("has no pace without a reset time", () => {
    expect(usagePace({ ...base, resetsAt: undefined, remainingPercent: 50 })).toBeNull();
  });
});

describe("railPlanLabel", () => {
  it("drops the provider name and boilerplate", () => {
    expect(railPlanLabel("Claude Max subscription", "Claude")).toBe("Max");
  });

  it("returns null for account-only labels", () => {
    expect(railPlanLabel("Command Code account", "Command Code")).toBeNull();
  });
});
