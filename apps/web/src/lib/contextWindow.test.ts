import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity, TurnId } from "@t3tools/contracts";

import { deriveLatestContextWindowSnapshot, formatContextWindowTokens } from "./contextWindow";

function makeActivity(id: string, kind: string, payload: unknown): OrchestrationThreadActivity {
  return {
    id: EventId.make(id),
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: TurnId.make("turn-1"),
    createdAt: "2026-03-23T00:00:00.000Z",
  };
}

describe("contextWindow", () => {
  it("derives the latest valid context window snapshot", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 1000,
      }),
      makeActivity("activity-2", "tool.started", {}),
      makeActivity("activity-3", "context-window.updated", {
        usedTokens: 14_000,
        maxTokens: 258_000,
        compactsAutomatically: true,
        autoCompactThreshold: 200_000,
      }),
    ]);

    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(14_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.maxTokens).toBe(258_000);
    expect(snapshot?.compactsAutomatically).toBe(true);
    expect(snapshot?.autoCompactThreshold).toBe(200_000);
  });

  describe("current provider instance", () => {
    const claudeRow = makeActivity("activity-claude", "context-window.updated", {
      usedTokens: 171_100,
      maxTokens: 1_000_000,
      providerInstanceId: "claudeAgent",
    });

    it("reports nothing when only the previous provider reported usage", () => {
      expect(deriveLatestContextWindowSnapshot([claudeRow], "cursor")).toBeNull();
    });

    it("uses the newest row from the current instance, skipping a newer foreign row", () => {
      const older = makeActivity("activity-cursor", "context-window.updated", {
        usedTokens: 5_000,
        providerInstanceId: "cursor",
      });
      const snapshot = deriveLatestContextWindowSnapshot([older, claudeRow], "cursor");
      expect(snapshot).toMatchObject({ usedTokens: 5_000, providerInstanceId: "cursor" });
    });

    it("skips unstamped legacy rows once the current instance is known", () => {
      const legacy = makeActivity("activity-legacy", "context-window.updated", {
        usedTokens: 9_000,
      });
      expect(deriveLatestContextWindowSnapshot([legacy], "claudeAgent")).toBeNull();
    });

    it("does not filter when the current instance is unknown", () => {
      expect(deriveLatestContextWindowSnapshot([claudeRow])?.usedTokens).toBe(171_100);
      expect(deriveLatestContextWindowSnapshot([claudeRow], null)?.usedTokens).toBe(171_100);
    });
  });

  it("ignores malformed payloads", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {}),
    ]);

    expect(snapshot).toBeNull();
  });

  it("keeps valid zero-usage snapshots", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 0,
        maxTokens: 100_000,
      }),
    ]);

    expect(snapshot).toMatchObject({
      usedTokens: 0,
      maxTokens: 100_000,
      remainingTokens: 100_000,
      usedPercentage: 0,
      remainingPercentage: 100,
    });
  });

  it("formats compact token counts", () => {
    expect(formatContextWindowTokens(999)).toBe("999");
    expect(formatContextWindowTokens(1400)).toBe("1.4k");
    expect(formatContextWindowTokens(14_000)).toBe("14k");
    expect(formatContextWindowTokens(258_000)).toBe("258k");
  });

  it("includes total processed tokens when available", () => {
    const snapshot = deriveLatestContextWindowSnapshot([
      makeActivity("activity-1", "context-window.updated", {
        usedTokens: 81_659,
        totalProcessedTokens: 748_126,
        maxTokens: 258_400,
        lastUsedTokens: 81_659,
      }),
    ]);

    expect(snapshot?.usedTokens).toBe(81_659);
    expect(snapshot?.totalProcessedTokens).toBe(748_126);
  });
});
