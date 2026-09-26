import { describe, expect, it } from "@effect/vitest";

import { commandCodePlan, commandCodeUsageToLimits } from "./commandCodeUsageLimits.ts";

const checkedAt = "2026-09-26T00:00:00.000Z";

describe("commandCodeUsageToLimits", () => {
  it("reports dollars left and the share of an active plan already used", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: { credits: { monthlyCredits: 7.5, purchasedCredits: 0, freeCredits: 0 } },
        subscription: {
          data: {
            planId: "individual-pro-monthly",
            status: "active",
            currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          },
        },
        summary: { totalCost: 22.5 },
      },
      checkedAt,
    );
    const [window] = limits.windows;
    expect(window?.label).toBe("Pro credits · $7.50 left");
    expect(window?.usedPercent).toBe(75);
    expect(window?.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("uses spend plus balance without an active plan, and reports failure without data", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: { credits: { monthlyCredits: 0, purchasedCredits: 5, freeCredits: 0 } },
        subscription: null,
        summary: { totalCost: 15 },
      },
      checkedAt,
    );
    expect(limits.windows[0]?.usedPercent).toBe(75);
    expect(limits.windows[0]?.label).toBe("Credits · $5.00 left");
    expect(
      commandCodeUsageToLimits({ credits: null, subscription: null, summary: null }, checkedAt)
        .unavailable?.reason,
    ).toBe("probeFailed");
  });

  it("matches plan ids by their longest prefix", () => {
    expect(commandCodePlan("individual-pro-v1-annual")).toEqual({
      name: "Pro",
      monthlyCredits: 80,
    });
    expect(commandCodePlan("INDIVIDUAL_MAX")).toEqual({ name: "Max", monthlyCredits: 150 });
    expect(commandCodePlan("enterprise")).toBeNull();
  });
});
