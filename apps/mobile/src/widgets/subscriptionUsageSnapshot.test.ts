import { EnvironmentId, ProviderDriverKind, ProviderInstanceId, UsageLimitSourceId, type ServerProvider } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import {
  buildSubscriptionUsageSnapshot,
  createWidgetRefresher,
  WIDGET_REFRESH_INTERVAL,
  subscriptionUsageDeadlines,
  subscriptionUsageTimeline,
} from "./subscriptionUsageSnapshot";

const checkedAt = "2026-09-05T12:00:00.000Z";
const now = Date.parse(checkedAt);
const window = {
  id: "session",
  kind: "session",
  label: "5 hours",
  usedPercent: 40,
  resetsAt: "2026-09-05T12:10:00.000Z",
} as const;
const limits = { checkedAt, windows: [window] };
const deepLink = "t3code-dev://settings/usage?tab=limits";
function provider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: ProviderDriverKind.make("codex"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated", email: "private@example.com" },
    checkedAt,
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: limits,
    ...overrides,
  };
}
function presentations(providers: readonly ServerProvider[] = [provider()]) {
  return new Map([
    [
      EnvironmentId.make("env"),
      { entry: { target: { label: "Remote" } }, serverConfig: { providers } },
    ],
  ]);
}

describe("subscription widget snapshots", () => {
  it("uses provider data and its observation time without exposing account emails", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ displayName: "private@example.com" })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(now);
    expect(snapshot.providers[0]).toMatchObject({
      driver: "codex",
      name: "Codex",
      detail: "",
      windows: [{ remaining: 60, resetAt: now + 10 * 60_000 }],
    });
    expect(snapshot.url).toBe(deepLink);
    expect(JSON.stringify(snapshot)).not.toContain("private@example.com");
  });
  it("clears data after removing environments", () => {
    expect(buildSubscriptionUsageSnapshot(new Map(), deepLink).providers).toEqual([]);
  });
  it.each<{ name: string; overrides: Partial<ServerProvider> }>([
    { name: "disabled", overrides: { enabled: false } },
    {
      name: "missing",
      overrides: { installed: false, status: "error", usageLimits: undefined },
    },
    {
      name: "API-key",
      overrides: {
        usageLimits: { checkedAt, windows: [], unavailable: { reason: "unsupported" } },
      },
    },
  ])("hides $name providers", ({ overrides }) => {
    expect(
      buildSubscriptionUsageSnapshot(presentations([provider(overrides)]), deepLink).providers,
    ).toEqual([]);
  });
  it("shows every provider that reports limits, readings first, and skips ones that cannot", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          instanceId: ProviderInstanceId.make("grok"),
          driver: ProviderDriverKind.make("grok"),
          usageLimits: undefined,
        }),
        provider({
          instanceId: ProviderInstanceId.make("cursor"),
          driver: ProviderDriverKind.make("cursor"),
        }),
        provider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          auth: { status: "authenticated", email: "claude@example.com" },
        }),
        provider({
          instanceId: ProviderInstanceId.make("commandCode"),
          driver: ProviderDriverKind.make("commandCode"),
          usageLimits: { checkedAt, windows: [] },
        }),
      ]),
      deepLink,
    );
    expect(snapshot.providers.map((entry) => [entry.name, entry.detail])).toEqual([
      ["Claude", ""],
      ["Cursor", ""],
      ["Command Code", "No data yet"],
    ]);
  });
  it("keeps an enabled provider visible before its first usage read", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { checkedAt, windows: [] } })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(0);
    expect(snapshot.providers).toEqual([
      { driver: "codex", name: "Codex", detail: "No data yet", windows: [], totalWindows: 0 },
    ]);
  });
  it("uses upstream deduplication for a native account also present in a proxy hub", () => {
    const input = new Map([
      [
        EnvironmentId.make("env"),
        {
          entry: { target: { label: "Remote" } },
          serverConfig: {
            providers: [provider()],
            usageLimitSources: [
              {
                id: UsageLimitSourceId.make("hub"),
                kind: "cliproxy" as const,
                label: "Hub",
                checkedAt,
                accounts: [
                  {
                    id: "account",
                    driver: ProviderDriverKind.make("codex"),
                    email: " PRIVATE@example.com ",
                    usageLimits: limits,
                  },
                ],
              },
            ],
          },
        },
      ],
    ]);
    expect(buildSubscriptionUsageSnapshot(input, deepLink).providers[0]?.detail).toBe("");
    input.get(EnvironmentId.make("env"))!.serverConfig.providers = [];
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.name).toBe("Codex");
    expect(JSON.stringify(snapshot)).not.toContain("example.com");
  });
  it("keeps unavailable quotas distinct from zero usage and omits provider error messages", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({
          usageLimits: {
            ...limits,
            unavailable: { reason: "probeFailed", message: "token secret" },
          },
        }),
      ]),
      deepLink,
    );
    expect(snapshot.providers[0]?.windows).toEqual([]);
    expect(JSON.stringify(snapshot)).not.toContain("token secret");
    expect(
      buildSubscriptionUsageSnapshot(
        presentations([
          provider({ usageLimits: { checkedAt, windows: [{ ...window, usedPercent: 0 }] } }),
        ]),
        deepLink,
      ).providers[0]?.windows[0]?.remaining,
    ).toBe(100);
  });
  it("bounds OS storage to session, weekly and the most constrained windows", () => {
    const windows = [
      ...Array.from({ length: 20 }, (_, index) => ({
        ...window,
        id: `${index}`,
        kind: "other" as const,
        usedPercent: index * 5,
      })),
      { ...window, id: "weekly", kind: "weekly" as const, label: "Weekly", usedPercent: 0 },
    ];
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { checkedAt, windows } })]),
      deepLink,
    );
    expect(snapshot.providers[0]?.totalWindows).toBe(21);
    expect(snapshot.providers[0]?.windows.map((entry) => entry.remaining)).toEqual([
      100, 25, 20, 15, 10, 5,
    ]);
  });
  it("keeps a reading without a reset time instead of expiring it", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider({ usageLimits: { checkedAt, windows: [{ ...window, resetsAt: undefined }] } }),
      ]),
      deepLink,
    );
    expect(snapshot.providers[0]?.windows).toEqual([
      { kind: "session", label: "5 hours", remaining: 60, resetAt: 0 },
    ]);
    expect(subscriptionUsageTimeline(snapshot, now + 24 * 60 * 60_000)).toEqual([
      { date: new Date(now + 24 * 60 * 60_000), props: snapshot },
    ]);
  });
  it("schedules a timeline entry at each future refill", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([
        provider(),
        provider({
          instanceId: ProviderInstanceId.make("claude"),
          driver: ProviderDriverKind.make("claudeAgent"),
          usageLimits: {
            checkedAt,
            windows: [
              window,
              { ...window, id: "weekly", kind: "weekly", resetsAt: "2026-09-05T13:00:00.000Z" },
            ],
          },
        }),
      ]),
      deepLink,
    );
    expect(subscriptionUsageDeadlines(snapshot, now)).toEqual([
      now + 10 * 60_000,
      now + 60 * 60_000,
    ]);
    const timeline = subscriptionUsageTimeline(snapshot, now + 30 * 60_000);
    expect(timeline.map((entry) => entry.date.getTime())).toEqual([
      now + 30 * 60_000,
      now + 60 * 60_000,
    ]);
    expect(timeline.every((entry) => entry.props === snapshot)).toBe(true);
  });
  it("leaves the check time empty for a malformed reading without storing null", () => {
    const snapshot = buildSubscriptionUsageSnapshot(
      presentations([provider({ usageLimits: { ...limits, checkedAt: "invalid" } })]),
      deepLink,
    );
    expect(snapshot.checkedAt).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain("null");
  });
  it("uses the freshest copy of an account across environments before pooling", () => {
    const input = presentations();
    input.set(EnvironmentId.make("other"), {
      entry: { target: { label: "Other" } },
      serverConfig: {
        providers: [
          provider({
            usageLimits: {
              checkedAt: new Date(now + 60_000).toISOString(),
              windows: [{ ...window, usedPercent: 80 }],
            },
          }),
        ],
      },
    });
    const snapshot = buildSubscriptionUsageSnapshot(input, deepLink);
    expect(snapshot.providers[0]?.detail).toBe("");
    expect(snapshot.providers[0]?.windows[0]?.remaining).toBe(20);
  });
});

describe("widget refresh probes", () => {
  it("throttles each connected environment independently and retries failures", async () => {
    const probe = vi
      .fn<(id: string) => Promise<void>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const refresh = createWidgetRefresher(probe);
    await refresh([], now);
    expect(probe).not.toHaveBeenCalled();
    await refresh(["first"], now);
    await refresh(["first", "second"], now + 1);
    expect(probe.mock.calls).toEqual([["first"], ["second"]]);
    await refresh(["first"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe.mock.calls).toEqual([["first"], ["second"], ["first"]]);
  });

  it("does not overlap a slow probe even after the refresh interval", async () => {
    let finish!: () => void;
    const probe = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const refresh = createWidgetRefresher(probe);
    const first = refresh(["one", "one"], now);
    await refresh(["one"], now + WIDGET_REFRESH_INTERVAL);
    expect(probe).toHaveBeenCalledTimes(1);
    finish();
    await first;
  });
});
