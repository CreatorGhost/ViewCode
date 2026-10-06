import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { planUsageWindow } from "../chat/composerUsageLimits.logic";

/** How much of a rail ring is left to spend, from comfortable to nearly out. */
export type RailRingTone = "healthy" | "fair" | "low" | "critical";

export function railRingTone(remainingPercent: number): RailRingTone {
  if (remainingPercent >= 50) return "healthy";
  if (remainingPercent >= 25) return "fair";
  if (remainingPercent >= 10) return "low";
  return "critical";
}

export type RailUsageRing = {
  entry: ProviderInstanceEntry;
  /** The most constrained window, which is what the ring draws. */
  window: ServerProviderUsageWindow | null;
  remainingPercent: number | null;
  tone: RailRingTone | null;
};

/** The window closest to exhaustion; the ring warns about whichever limit hits first. */
export function mostConstrainedWindow(
  entry: ProviderInstanceEntry,
): ServerProviderUsageWindow | null {
  const limits = entry.snapshot.usageLimits;
  const headline = planUsageWindow(limits, entry.driverKind);
  if (!headline || !limits) return null;
  const candidates =
    entry.driverKind === "claudeAgent"
      ? limits.windows.filter((window) => window.id === "five_hour" || window.id === "seven_day")
      : limits.windows;
  return candidates.reduce<ServerProviderUsageWindow>(
    (worst, window) => (window.usedPercent > worst.usedPercent ? window : worst),
    headline,
  );
}

/** One ring per enabled, reachable account; accounts without limits still get a (quiet) ring. */
export function buildRailUsageRings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<RailUsageRing> {
  return entries
    .filter((entry) => entry.enabled && entry.isAvailable && entry.installed)
    .map((entry) => {
      const window = mostConstrainedWindow(entry);
      if (!window) return { entry, window: null, remainingPercent: null, tone: null };
      const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
      return { entry, window, remainingPercent, tone: railRingTone(remainingPercent) };
    });
}
