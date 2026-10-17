import { PROVIDER_DISPLAY_NAMES } from "@t3tools/contracts";
import {
  collectLimitAccounts,
  collectLimitPools,
  displayLimitWindows,
  providersWithLimits,
  type LimitPresentations,
} from "@t3tools/shared/usageLimits";

export interface SubscriptionUsageSnapshot {
  url?: string;
  /** The oldest reading behind the snapshot, or 0 before the first one. */
  checkedAt: number;
  providers: Array<{
    driver: string;
    name: string;
    /** A pooled account count, why there is nothing to show, or empty. */
    detail: string;
    windows: Array<{
      kind?: string;
      label: string;
      remaining: number;
      /** When the window next refills, or 0 when the provider does not say. */
      resetAt: number;
    }>;
    totalWindows: number;
  }>;
}

export const WIDGET_REFRESH_INTERVAL = 5 * 60_000;

// Codex and Claude lead, matching the Limits tab; drivers not listed follow in pool order.
const DRIVER_ORDER = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "commandCode",
  "droid",
  "devin",
  "pi",
];

/** Bound probes across config updates, reconnects, and foreground transitions. */
export function createWidgetRefresher<Id>(refresh: (id: Id) => Promise<unknown>) {
  const attempted = new Map<Id, number>();
  const pending = new Set<Id>();
  return async (connected: readonly Id[], now: number) => {
    await Promise.allSettled(
      connected.map(async (id) => {
        if (pending.has(id) || now - (attempted.get(id) ?? -Infinity) < WIDGET_REFRESH_INTERVAL)
          return;
        attempted.set(id, now);
        pending.add(id);
        try {
          await refresh(id);
        } finally {
          pending.delete(id);
        }
      }),
    );
  };
}

/**
 * Deduplicate accounts before pooling, and only publish display data to the OS.
 * Readings never expire here: the widget keeps showing the last one, with its
 * age, until the app publishes a newer one.
 */
export function buildSubscriptionUsageSnapshot(
  presentations: LimitPresentations,
  url: string,
  maxWindowsPerProvider = 6,
): SubscriptionUsageSnapshot {
  const pools = collectLimitPools(collectLimitAccounts(presentations), 0);
  const configured = [...presentations.values()].flatMap((presentation) =>
    // API-key accounts have no subscription to show.
    providersWithLimits(presentation.serverConfig?.providers ?? [])
      .filter((provider) => provider.usageLimits?.unavailable?.reason !== "unsupported")
      .map((provider): string => provider.driver),
  );
  const drivers = [...new Set<string>([...pools.map((pool) => pool.driver), ...configured])];
  const checked = pools
    .flatMap((pool) => pool.accounts.map((account) => Date.parse(account.limits.checkedAt)))
    .filter(Number.isFinite);
  const providers = drivers.map((driver) => {
    const pool = pools.find((candidate) => candidate.driver === driver);
    const name = PROVIDER_DISPLAY_NAMES[driver as keyof typeof PROVIDER_DISPLAY_NAMES] ?? driver;
    const ordered = pool ? displayLimitWindows(pool) : [];
    if (!pool || ordered.length === 0)
      return { driver, name, detail: "No data yet", windows: [], totalWindows: 0 };
    const tightest = [...ordered].sort((a, b) => a.remainingPercent - b.remainingPercent);
    // Keep a session and weekly limit when scoped limits fill the storage budget.
    const kept = new Set(
      [
        ordered.find((window) => window.kind === "session"),
        ordered.find((window) => window.kind === "weekly"),
        ...tightest,
      ]
        .filter((window) => window !== undefined)
        .slice(0, maxWindowsPerProvider),
    );
    return {
      driver,
      name,
      detail: pool.accounts.length > 1 ? `${pool.accounts.length} accounts` : "",
      totalWindows: ordered.length,
      windows: ordered
        .filter((window) => kept.has(window))
        .map((window) => ({
          kind: window.kind,
          label: window.label,
          remaining: Math.round(window.remainingPercent),
          resetAt: window.resets[0]?.at ?? 0,
        })),
    };
  });
  const rank = (driver: string) => {
    const index = DRIVER_ORDER.indexOf(driver);
    return index < 0 ? DRIVER_ORDER.length : index;
  };
  return {
    checkedAt: checked.length > 0 ? Math.min(...checked) : 0,
    // Readings first, so a small widget spends its space on numbers.
    providers: providers.sort(
      (a, b) =>
        Number(b.windows.length > 0) - Number(a.windows.length > 0) ||
        rank(a.driver) - rank(b.driver),
    ),
    url,
  };
}

/** Future refills, soonest first: the moments a widget showing this snapshot changes. */
export function subscriptionUsageDeadlines(snapshot: SubscriptionUsageSnapshot, now: number) {
  return [
    ...new Set(
      snapshot.providers.flatMap((provider) => provider.windows.map((window) => window.resetAt)),
    ),
  ]
    .filter((at) => at > now)
    .sort((a, b) => a - b);
}

/** One entry now and one per refill, so iOS redraws each window as it resets. */
export function subscriptionUsageTimeline(snapshot: SubscriptionUsageSnapshot, now: number) {
  return [now, ...subscriptionUsageDeadlines(snapshot, now)].map((date) => ({
    date: new Date(date),
    props: snapshot,
  }));
}
