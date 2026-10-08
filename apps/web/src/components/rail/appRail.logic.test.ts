import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ProviderInstanceEntry } from "../../providerInstances";
import {
  buildRailProjectActivity,
  buildRailUsageRings,
  railProjectLabel,
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

describe("buildRailProjectActivity", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  // One folder grouping the same repo on two machines, and a second folder.
  const groups = [
    {
      projectKey: "app",
      memberProjectRefs: [
        { environmentId: local, projectId: ProjectId.make("p1") },
        { environmentId: remote, projectId: ProjectId.make("p9") },
      ],
    },
    {
      projectKey: "docs",
      memberProjectRefs: [{ environmentId: local, projectId: ProjectId.make("p2") }],
    },
  ];
  type ActivityThread = Parameters<typeof buildRailProjectActivity>[1][number];
  const thread = (
    environmentId: EnvironmentId,
    projectId: string,
    overrides: Record<string, unknown> = {},
  ) =>
    ({
      environmentId,
      projectId,
      archivedAt: null,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      session: null,
      ...overrides,
    }) as unknown as ActivityThread;

  it("counts threads waiting on the user and working threads across a folder's machines", () => {
    const activity = buildRailProjectActivity(groups, [
      thread(local, "p1", { hasPendingApprovals: true }),
      thread(remote, "p9", { hasPendingUserInput: true }),
      thread(remote, "p9", { session: { status: "running" } }),
      thread(local, "p2", { backgroundLiveness: "working" }),
      thread(local, "p2"),
    ]);
    expect(Object.fromEntries(activity)).toEqual({
      app: { needsYou: 2, working: 1 },
      docs: { needsYou: 0, working: 1 },
    });
  });

  it("skips archived threads, side chats, failures, and projects outside the folders", () => {
    const activity = buildRailProjectActivity(groups, [
      thread(local, "p1", { hasPendingApprovals: true, archivedAt: "2026-01-01T00:00:00.000Z" }),
      thread(local, "p1", { hasPendingApprovals: true, kind: "sidechat" }),
      thread(local, "gone", { hasPendingApprovals: true }),
      thread(local, "p2", { session: { status: "error" } }),
    ]);
    expect(activity.size).toBe(0);
  });
});

describe("railProjectLabel", () => {
  it("names the waiting count first, then working", () => {
    expect(railProjectLabel("slicerninja", { needsYou: 2, working: 1 })).toBe(
      "slicerninja, 2 need you",
    );
    expect(railProjectLabel("slicerninja", { needsYou: 1, working: 0 })).toBe(
      "slicerninja, 1 needs you",
    );
    expect(railProjectLabel("slicerninja", { needsYou: 0, working: 3 })).toBe(
      "slicerninja, working",
    );
    expect(railProjectLabel("slicerninja", undefined)).toBe("slicerninja");
  });
});
