import { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildRailUsageRings,
  railRingTone,
  railRingTracks,
  resolveRailEnvironmentId,
} from "./appRail.logic";

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

  it("skips disabled accounts and accounts that report no usage limits", () => {
    const rings = buildRailUsageRings([
      entry("a", "codex", [], { enabled: false }),
      entry("b", "opencode", []),
    ]);
    expect(rings).toHaveLength(0);
  });

  it("draws an idle ring when limits read fine but no window is active yet", () => {
    const checkedAt = new Date(0).toISOString();
    const rings = buildRailUsageRings([
      entry("claudeAgent", "claudeAgent", [], {
        snapshot: { usageLimits: { checkedAt, windows: [] } },
      } as unknown as Partial<ProviderInstanceEntry>),
    ]);
    expect(rings).toHaveLength(1);
    expect(rings[0]?.window).toBeNull();
    expect(rings[0]?.tracks).toEqual([]);
  });

  it("draws no ring for an account without subscription limits or with a failed probe", () => {
    const checkedAt = new Date(0).toISOString();
    const rings = buildRailUsageRings(
      (["unsupported", "probeFailed"] as const).map((reason) =>
        entry(reason, "claudeAgent", [], {
          snapshot: { usageLimits: { checkedAt, windows: [], unavailable: { reason } } },
        } as unknown as Partial<ProviderInstanceEntry>),
      ),
    );
    expect(rings).toHaveLength(0);
  });
});

describe("resolveRailEnvironmentId", () => {
  const primary = EnvironmentId.make("env-primary");
  const remote = EnvironmentId.make("env-remote");
  const draft = EnvironmentId.make("env-draft");

  it("follows the open thread's environment, then its draft, then the primary", () => {
    expect(
      resolveRailEnvironmentId({
        routeEnvironmentId: remote,
        draftEnvironmentId: draft,
        primaryEnvironmentId: primary,
      }),
    ).toBe(remote);
    expect(
      resolveRailEnvironmentId({
        routeEnvironmentId: null,
        draftEnvironmentId: draft,
        primaryEnvironmentId: primary,
      }),
    ).toBe(draft);
    expect(
      resolveRailEnvironmentId({
        routeEnvironmentId: null,
        draftEnvironmentId: null,
        primaryEnvironmentId: primary,
      }),
    ).toBe(primary);
    expect(
      resolveRailEnvironmentId({
        routeEnvironmentId: null,
        draftEnvironmentId: null,
        primaryEnvironmentId: null,
      }),
    ).toBeNull();
  });
});

describe("railRingTracks", () => {
  const w = (
    id: string,
    kind: "session" | "weekly" | "monthly" | "other",
    usedPercent: number,
  ) => ({ id, kind, label: id, usedPercent });

  it("draws weekly outside and the session inside, skipping model-scoped weeklies", () => {
    const tracks = railRingTracks(
      [
        w("five_hour", "session", 73),
        w("seven_day_fable", "weekly", 0),
        w("seven_day", "weekly", 46),
      ],
      w("five_hour", "session", 73),
    );
    expect(tracks.map((t) => [t.window.id, t.remainingPercent])).toEqual([
      ["seven_day", 54],
      ["five_hour", 27],
    ]);
  });

  it("keeps the one window an account reports", () => {
    const only = w("primary", "weekly", 2);
    expect(railRingTracks([only], only).map((t) => t.window.id)).toEqual(["primary"]);
  });
});
