import type { ServerProviderUsageWindow, UsageProviderKind } from "@t3tools/contracts";
import { formatTokens } from "@t3tools/shared/usageFormat";
import type { ProviderTotals } from "@t3tools/shared/usageMerge";

import { formatResetsIn } from "@t3tools/shared/usageLimits";

import { formatUsedPercent, orderUsageWindows } from "../chat/composerUsageLimits.logic";
import { railRingTone, type RailRingTone } from "./appRail.logic";

export type RailUsageCardRow = {
  id: string;
  label: string;
  /** 0-100, what the progress track fills. */
  remainingPercent: number;
  /** `72% left`. */
  remainingText: string;
  /** `Resets in 4 hr 41 min`, null when the window has no reset time. */
  reset: string | null;
  tone: RailRingTone;
  /** Where the bar should be by now at an even pace, 0-100; null without a reset time and duration. */
  markerPercent: number | null;
  /** The marker's colour: green when ahead of pace, amber near it, red when running out early. */
  paceTone: RailRingTone;
  /** `11% in reserve` / `32% in deficit`; null when on pace to the percent. */
  paceAmount: string | null;
  /** `Lasts until reset` / `Runs out in 1d 4h` / `Limit reached`. */
  paceEta: string | null;
};

/**
 * How a window is being spent against an even pace, as OpenUsage and Synara draw it.
 * Projects the current rate to the reset: under 80% used at reset is ahead, up to
 * 100% on track, past it behind (with a run-out time).
 */
export function usagePace(input: {
  remainingPercent: number;
  resetsAt: string | undefined;
  windowDurationMins: number | undefined;
  now: number;
}): {
  markerPercent: number;
  status: "ahead" | "on-track" | "behind";
  amount: string | null;
  eta: string | null;
} | null {
  if (!input.resetsAt || !input.windowDurationMins) return null;
  const resetMs = Date.parse(input.resetsAt);
  const durationMs = input.windowDurationMins * 60_000;
  if (!Number.isFinite(resetMs) || durationMs <= 0) return null;
  const elapsedMs = input.now - (resetMs - durationMs);
  if (elapsedMs <= 0 || input.now >= resetMs) return null;

  const used = clamp(100 - input.remainingPercent);
  // ponytail: 5% floor, as Synara does, so the first minutes of a window do not project wildly.
  const elapsed = Math.max(elapsedMs / durationMs, 0.05);
  const expectedUsed = clamp(elapsed * 100);
  const projected = used === 0 ? 0 : used / elapsed;
  const status =
    used >= 100
      ? "behind"
      : used === 0 || projected <= 80
        ? "ahead"
        : projected <= 100
          ? "on-track"
          : "behind";
  const delta = Math.round(Math.abs(used - expectedUsed));
  const amount =
    delta === 0 ? null : used > expectedUsed ? `${delta}% in deficit` : `${delta}% in reserve`;

  let eta: string | null = "Lasts until reset";
  if (status === "behind") {
    const etaMs = projected > 0 ? (100 - used) / (projected / durationMs) : 0;
    const duration = etaMs > 0 && etaMs < resetMs - input.now ? compactDuration(etaMs) : null;
    eta = used >= 100 ? "Limit reached" : duration ? `Runs out in ${duration}` : null;
  }
  return { markerPercent: clamp(100 - expectedUsed), status, amount, eta };
}

function clamp(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function compactDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes % 60}m`;
  return minutes > 0 ? `${minutes}m` : "<1m";
}

const PACE_TONE = { ahead: "healthy", "on-track": "low", behind: "critical" } as const;

/** `Resets in 5d 23h`, the compact form Synara and the Usage page share. */
function resetText(window: ServerProviderUsageWindow, now: number): string | null {
  const text = formatResetsIn(window, now);
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : null;
}

/** One row per limit window, shortest window first, in the shape the hover card draws. */
export function buildRailUsageCardRows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): ReadonlyArray<RailUsageCardRow> {
  return orderUsageWindows(windows).map((window) => {
    const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
    const tone = railRingTone(remainingPercent);
    const pace = usagePace({
      remainingPercent,
      resetsAt: window.resetsAt,
      windowDurationMins: window.windowDurationMins,
      now,
    });
    return {
      id: window.id,
      label: window.label,
      remainingPercent,
      remainingText: `${formatUsedPercent(remainingPercent)} left`,
      reset: resetText(window, now),
      tone,
      markerPercent: pace?.markerPercent ?? null,
      paceTone: pace ? PACE_TONE[pace.status] : tone,
      paceAmount: pace?.amount ?? null,
      paceEta: pace?.eta ?? null,
    };
  });
}

/**
 * The plan as the card header shows it: "Max", not "Claude Max subscription".
 * Null for labels that name only the account ("Command Code account"), which
 * carry no plan information next to the provider name already in the header.
 */
export function railPlanLabel(authLabel: string | undefined, providerName: string): string | null {
  if (!authLabel) return null;
  let plan = authLabel.replace(/\s+(subscription|plan)$/i, "").trim();
  const prefix = providerName.trim();
  if (prefix && plan.toLowerCase().startsWith(`${prefix.toLowerCase()} `)) {
    plan = plan.slice(prefix.length).trim();
  }
  if (!plan || /\baccount$/i.test(plan) || plan.toLowerCase() === prefix.toLowerCase()) return null;
  return plan;
}

const USAGE_PROVIDER_BY_DRIVER: Record<string, UsageProviderKind> = {
  codex: "codex",
  claudeAgent: "claude",
  grok: "grok",
  cursor: "cursor",
  opencode: "opencode",
  antigravity: "antigravity",
};

/** The usage-report provider a driver's tokens are filed under; null for drivers the report does not cover. */
export function usageProviderForDriver(driverKind: string): UsageProviderKind | null {
  return USAGE_PROVIDER_BY_DRIVER[driverKind] ?? null;
}

export type RailTokenRow = { label: string; tokens: string; sessions: string };

/** `24h · 439M tokens · 28 recent sessions`, one row per window that has any usage for the provider. */
export function railTokenRows(
  provider: UsageProviderKind,
  windows: ReadonlyArray<{ label: string; providers: ReadonlyArray<ProviderTotals> }>,
): ReadonlyArray<RailTokenRow> {
  return windows.flatMap(({ label, providers }) => {
    const totals = providers.find((entry) => entry.provider === provider);
    if (!totals || totals.totalTokens <= 0) return [];
    return [
      {
        label,
        tokens: `${formatTokens(totals.totalTokens)} tokens`,
        sessions: `${totals.sessions} recent ${totals.sessions === 1 ? "session" : "sessions"}`,
      },
    ];
  });
}
