import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { buildRailUsageRings, railRingTone } from "./appRail.logic";

function entry(
  id: string,
  driver: string,
  windows: ReadonlyArray<{ id: string; kind: "session" | "weekly"; usedPercent: number }>,
  overrides: Partial<ProviderInstanceEntry> = {},
): ProviderInstanceEntry {
  return {
    instanceId: ProviderInstanceId.make(id),
    driverKind: ProviderDriverKind.make(driver),
    displayName: id,
    enabled: true,
    installed: true,
    isAvailable: true,
    snapshot: {
      usageLimits:
        windows.length === 0
          ? undefined
          : {
              checkedAt: new Date(0).toISOString(),
              windows: windows.map((window) => ({ ...window, label: window.id })),
            },
    },
    ...overrides,
  } as unknown as ProviderInstanceEntry;
}

describe("railRingTone", () => {
  it("steps from healthy to critical as the quota runs out", () => {
    expect([100, 50, 49, 25, 24, 10, 9, 0].map(railRingTone)).toEqual([
      "healthy",
      "healthy",
      "fair",
      "fair",
      "low",
      "low",
      "critical",
      "critical",
    ]);
  });
});

describe("buildRailUsageRings", () => {
  it("draws the most constrained window as remaining quota", () => {
    const [ring] = buildRailUsageRings([
      entry("codex", "codex", [
        { id: "session", kind: "session", usedPercent: 20 },
        { id: "weekly", kind: "weekly", usedPercent: 85 },
      ]),
    ]);
    expect(ring?.window?.id).toBe("weekly");
    expect(ring?.remainingPercent).toBe(15);
    expect(ring?.tone).toBe("low");
  });

  it("ignores Claude's per-model buckets", () => {
    const [ring] = buildRailUsageRings([
      entry("claudeAgent", "claudeAgent", [
        { id: "five_hour", kind: "session", usedPercent: 10 },
        { id: "seven_day_opus", kind: "weekly", usedPercent: 99 },
      ]),
    ]);
    expect(ring?.window?.id).toBe("five_hour");
    expect(ring?.tone).toBe("healthy");
  });

  it("skips disabled accounts and keeps limit-less ones quiet", () => {
    const rings = buildRailUsageRings([
      entry("a", "codex", [], { enabled: false }),
      entry("b", "opencode", []),
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]).toMatchObject({ window: null, remainingPercent: null, tone: null });
  });
});
