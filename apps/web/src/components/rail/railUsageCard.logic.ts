import type { ServerProviderUsageWindow } from "@t3tools/contracts";

import {
  formatUsageReset,
  formatUsedPercent,
  orderUsageWindows,
} from "../chat/composerUsageLimits.logic";
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
};

/** One row per limit window, shortest window first, in the shape the hover card draws. */
export function buildRailUsageCardRows(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  now: number,
): ReadonlyArray<RailUsageCardRow> {
  return orderUsageWindows(windows).map((window) => {
    const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
    return {
      id: window.id,
      label: window.label,
      remainingPercent,
      remainingText: `${formatUsedPercent(remainingPercent)} left`,
      reset: formatUsageReset(window.resetsAt, now),
      tone: railRingTone(remainingPercent),
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
