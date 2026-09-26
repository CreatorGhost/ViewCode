import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;

/**
 * `Resets in 8 min` / `Resets in 3 hr 12 min` within a day, then the weekday
 * and local time (`Resets Sun 17:00`). Null when the window has no reset.
 */
export function formatUsageReset(resetsAt: string | undefined, now: number): string | null {
  if (resetsAt === undefined) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const remaining = at - now;
  if (remaining <= 0) return "Resets now";
  if (remaining < DAY) {
    const hours = Math.floor(remaining / HOUR);
    const minutes = Math.max(1, Math.ceil((remaining % HOUR) / MINUTE));
    if (hours === 0) return `Resets in ${minutes} min`;
    // A ceiling of exactly 60 minutes reads better as the next hour.
    if (minutes === 60) return `Resets in ${hours + 1} hr`;
    return `Resets in ${hours} hr ${minutes} min`;
  }
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `Resets ${WEEKDAYS[date.getDay()]} ${time}`;
}

/** Bars read accent while comfortable, amber from 80% used and red once exhausted. */
export type UsageTone = "normal" | "warning" | "critical";

export function usageTone(usedPercent: number): UsageTone {
  if (usedPercent >= 100) return "critical";
  if (usedPercent >= 80) return "warning";
  return "normal";
}

export function formatUsedPercent(usedPercent: number): string {
  return `${Math.round(Math.max(0, Math.min(100, usedPercent)))}%`;
}

const KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

/** Shortest window first (the session, then weekly), keeping provider order within a kind. */
export function orderUsageWindows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return windows.toSorted((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** The most-used window's percent, which the composer ring draws; null when nothing is known. */
export function peakUsedPercent(limits: ServerProviderUsageLimits | undefined): number | null {
  if (!limits || limits.unavailable?.reason === "unsupported" || limits.windows.length === 0) {
    return null;
  }
  return Math.max(...limits.windows.map((window) => window.usedPercent));
}

export type UsageProviderInput = {
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  displayName: string;
  plan: string | undefined;
  usageLimits: ServerProviderUsageLimits | undefined;
};

export type UsageSection = {
  key: string;
  role: "lead" | "agents";
  title: string;
  subtitle: string;
  instanceId: ProviderInstanceId;
  driver: ProviderDriverKind;
  /** `checking` while a probe is in flight with nothing to show yet. */
  status: "ready" | "checking" | "message";
  message: string | null;
  windows: ReadonlyArray<ServerProviderUsageWindow>;
  resetCredits: ServerProviderResetCredits | null;
};

function toSection(
  role: UsageSection["role"],
  provider: UsageProviderInput,
  refreshing: boolean,
): UsageSection {
  const limits = provider.usageLimits;
  const notice = limits ? limitsNotice(limits) : null;
  const status: UsageSection["status"] =
    limits && !notice ? "ready" : refreshing ? "checking" : "message";
  return {
    key: `${role}:${provider.instanceId}`,
    role,
    title: `${role === "lead" ? "Lead" : "Agents"} · ${provider.displayName}`,
    subtitle: provider.plan ? `Plan usage limits · ${provider.plan}` : "Plan usage limits",
    instanceId: provider.instanceId,
    driver: provider.driver,
    status,
    message:
      status === "message"
        ? (notice ?? `${provider.displayName} doesn't report plan limits.`)
        : null,
    windows: limits && !notice ? orderUsageWindows(limits.windows) : [],
    resetCredits:
      limits?.resetCredits && limits.resetCredits.availableCount > 0 ? limits.resetCredits : null,
  };
}

/**
 * The lead provider's section, then one per other provider the thread's child
 * agents run on, each provider once and in the order the agents appear.
 */
export function buildUsageSections(input: {
  lead: UsageProviderInput;
  agentProviders: ReadonlyArray<UsageProviderInput>;
  refreshingInstanceIds: ReadonlySet<ProviderInstanceId>;
}): ReadonlyArray<UsageSection> {
  const sections = [
    toSection("lead", input.lead, input.refreshingInstanceIds.has(input.lead.instanceId)),
  ];
  const seen = new Set<ProviderInstanceId>([input.lead.instanceId]);
  for (const provider of input.agentProviders) {
    if (seen.has(provider.instanceId)) continue;
    seen.add(provider.instanceId);
    sections.push(
      toSection("agents", provider, input.refreshingInstanceIds.has(provider.instanceId)),
    );
  }
  return sections;
}

/** Re-probe on open only when the last read is missing or older than this. */
export const USAGE_REFRESH_AFTER_MS = 60_000;

export function shouldRefreshUsage(
  limits: ServerProviderUsageLimits | undefined,
  now: number,
): boolean {
  // A driver with no notion of plan usage never reports limits; probing it again finds none.
  if (!limits || limits.unavailable?.reason === "unsupported") return false;
  const checkedAt = Date.parse(limits.checkedAt);
  return !Number.isFinite(checkedAt) || now - checkedAt > USAGE_REFRESH_AFTER_MS;
}
