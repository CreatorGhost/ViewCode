import { describe, expect, it } from "vite-plus/test";

import { buildRailUsageCardRows, railPlanLabel } from "./railUsageCard.logic";

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
      reset: "Resets in 4 hr 41 min",
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
