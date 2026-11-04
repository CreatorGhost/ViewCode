import { describe, expect, it } from "vite-plus/test";

import { codexRateLimitsToLimits } from "./codexUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";

// ViewCode reads the main allowance from a bucket map that may not carry a `codex`
// bucket (codexMainAllowance). Upstream takes `rateLimitsByLimitId.codex ?? snapshot`.
describe("codexRateLimitsToLimits main allowance", () => {
  it("falls back to the first bucket when no bucket is the main allowance", () => {
    const sol = {
      limitId: "codex_sol",
      primary: { usedPercent: 12, windowDurationMins: 300 },
      secondary: { usedPercent: 40, windowDurationMins: 10080 },
    };
    expect(
      codexRateLimitsToLimits({ checkedAt, snapshot: sol, rateLimitsByLimitId: { codex_sol: sol } })
        .windows,
    ).toEqual([
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      {
        id: "secondary",
        kind: "weekly",
        label: "Weekly",
        usedPercent: 40,
        windowDurationMins: 10080,
      },
    ]);
  });

  it("keeps a main snapshot over a foreign bucket", () => {
    const spark = { limitId: "codex_bengalfox", secondary: { usedPercent: 90 } };
    expect(
      codexRateLimitsToLimits({
        checkedAt,
        snapshot: { primary: { usedPercent: 12, windowDurationMins: 300 } },
        rateLimitsByLimitId: { codex_bengalfox: spark },
      }).windows,
    ).toEqual([
      {
        id: "primary",
        kind: "session",
        label: "Session",
        usedPercent: 12,
        windowDurationMins: 300,
      },
    ]);
  });
});
