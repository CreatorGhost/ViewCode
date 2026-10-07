import { describe, expect, it } from "vite-plus/test";

import { buildRailUsageCardRows, railPlanLabel, railTokenRows, usagePace } from "./railUsageCard.logic";

const NOW = Date.parse("2026-01-01T00:00:00Z");

describe("buildRailUsageCardRows", () => {
  it("orders the session before the week and reports what is left", () => {
    const rows = buildRailUsageCardRows(
      [
        { id: "w", label: "Weekly", kind: "weekly", usedPercent: 40 },
        {
          id: "s",
          label: "5h",
          kind: "session",
          usedPercent: 92.4,
          resetsAt: new Date(NOW + (4 * 60 + 41) * 60_000).toISOString(),
        },
      ],
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["s", "w"]);
    expect(rows[0]).toMatchObject({
      remainingText: "8% left",
      tone: "critical",
      reset: "Resets in 4h 41m",
    });
    expect(rows[1]).toMatchObject({ remainingText: "60% left", tone: "healthy", reset: null });
  });

  it("clamps an overshoot to zero left", () => {
    const [row] = buildRailUsageCardRows(
      [{ id: "s", label: "5h", kind: "session", usedPercent: 130 }],
      NOW,
    );
    expect(row?.remainingPercent).toBe(0);
    expect(row?.remainingText).toBe("0% left");
  });
});

describe("railPlanLabel", () => {
  it("drops the provider name and plan suffix, and hides account-only labels", () => {
    expect(railPlanLabel("Claude Max", "Claude")).toBe("Max");
    expect(railPlanLabel("ChatGPT Pro 20x Subscription", "Codex")).toBe("ChatGPT Pro 20x");
    expect(railPlanLabel("Command Code account", "Command Code")).toBeNull();
    expect(railPlanLabel(undefined, "Grok")).toBeNull();
  });
});

describe("usagePace", () => {
  const now = Date.parse("2026-10-07T12:00:00Z");
  const week = 7 * 24 * 60;
  // Weekly window that started 3.5 days ago: half the time is gone.
  const resetsAt = new Date(now + 3.5 * 24 * 3600_000).toISOString();

  it("reports reserve when spending slower than an even pace", () => {
    const pace = usagePace({ remainingPercent: 80, resetsAt, windowDurationMins: week, now });
    expect(pace).toMatchObject({ markerPercent: 50, status: "ahead", amount: "30% in reserve", eta: "Lasts until reset" });
  });

  it("reports deficit and a run-out time when spending faster", () => {
    const pace = usagePace({ remainingPercent: 20, resetsAt, windowDurationMins: week, now });
    // 80% used in half the window: 160% projected, runs out in 0.875 d.
    expect(pace).toMatchObject({ status: "behind", amount: "30% in deficit", eta: "Runs out in 21h 0m" });
  });

  it("says the limit is reached at 0% left", () => {
    expect(usagePace({ remainingPercent: 0, resetsAt, windowDurationMins: week, now })?.eta).toBe("Limit reached");
  });

  it("has nothing to say without a reset time or a duration", () => {
    expect(usagePace({ remainingPercent: 50, resetsAt: undefined, windowDurationMins: week, now })).toBeNull();
    expect(usagePace({ remainingPercent: 50, resetsAt, windowDurationMins: undefined, now })).toBeNull();
  });
});

describe("railTokenRows", () => {
  const totals = (provider: "codex" | "claude", totalTokens: number, sessions: number) => ({
    provider, totalTokens, sessions, costUsd: 0, records: 0, costShare: 0, tokenShare: 0,
  });

  it("lists each window the provider used, skipping empty ones", () => {
    const rows = railTokenRows("codex", [
      { label: "24h", providers: [totals("codex", 439_000_000, 28), totals("claude", 1e9, 101)] },
      { label: "7d", providers: [totals("claude", 3e9, 273)] },
      { label: "30d", providers: [totals("codex", 4e9, 1)] },
    ]);
    expect(rows).toEqual([
      { label: "24h", tokens: "439M tokens", sessions: "28 recent sessions" },
      { label: "30d", tokens: "4B tokens", sessions: "1 recent session" },
    ]);
  });
});
