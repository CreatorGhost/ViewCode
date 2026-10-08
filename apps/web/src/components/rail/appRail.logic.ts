import type { EnvironmentId, ServerProviderUsageWindow } from "@t3tools/contracts";

import type { ProviderInstanceEntry } from "../../providerInstances";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { planUsageWindow } from "../chat/composerUsageLimits.logic";
import { resolveSidebarThreadStatus } from "../Sidebar.logic";

/** How much of a rail ring is left to spend, from comfortable to nearly out. */
export type RailRingTone = "healthy" | "fair" | "low" | "critical";

export function railRingTone(remainingPercent: number): RailRingTone {
  if (remainingPercent >= 50) return "healthy";
  if (remainingPercent >= 25) return "fair";
  if (remainingPercent >= 10) return "low";
  return "critical";
}

export type RailRingTrack = {
  window: ServerProviderUsageWindow;
  remainingPercent: number;
  tone: RailRingTone;
};

export type RailUsageRing = {
  entry: ProviderInstanceEntry;
  /**
   * The most constrained window: the button's label and the single-ring fallback. Null on an
   * idle ring, whose account reads limits but has no window active yet (before the first turn).
   */
  window: ServerProviderUsageWindow | null;
  remainingPercent: number;
  tone: RailRingTone;
  /** What the ring draws, outermost first: weekly outside, the session window inside (as Synara does). Empty when idle. */
  tracks: ReadonlyArray<RailRingTrack>;
};

function track(window: ServerProviderUsageWindow): RailRingTrack {
  const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
  return { window, remainingPercent, tone: railRingTone(remainingPercent) };
}

/**
 * Weekly outside and the session window inside when the account reports both;
 * otherwise the one window it has. Named sublimits (`Fable`, `Opus`) stay in the card.
 */
export function railRingTracks(
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  fallback: ServerProviderUsageWindow,
): ReadonlyArray<RailRingTrack> {
  // Model-scoped weeklies (`seven_day_fable`) are sublimits, not the account's week.
  const weekly =
    windows.find((window) => window.kind === "weekly" && !window.id.startsWith("seven_day_")) ??
    windows.find((window) => window.kind === "weekly");
  const session = windows.find((window) => window.kind === "session");
  const picked = [weekly, session].filter((window) => window !== undefined);
  return (picked.length > 0 ? picked : [fallback]).map(track);
}

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

/**
 * One ring per enabled, reachable account that reports usage limits. An account whose
 * limits read fine but have no window yet gets an idle ring, so the rail is not blank
 * until the first message. No subscription limits, a failed probe, or a provider that
 * reports none gets no ring.
 */
export function buildRailUsageRings(
  entries: ReadonlyArray<ProviderInstanceEntry>,
): ReadonlyArray<RailUsageRing> {
  return entries
    .filter((entry) => entry.enabled && entry.isAvailable && entry.installed)
    .flatMap<RailUsageRing>((entry) => {
      const window = mostConstrainedWindow(entry);
      if (!window) {
        const limits = entry.snapshot.usageLimits;
        const idle = !!limits && !limits.unavailable && limits.windows.length === 0;
        return idle
          ? [{ entry, window: null, remainingPercent: 100, tone: "healthy", tracks: [] }]
          : [];
      }
      const remainingPercent = Math.max(0, Math.min(100, 100 - window.usedPercent));
      const tracks = railRingTracks(entry.snapshot.usageLimits?.windows ?? [], window);
      return [{ entry, window, remainingPercent, tone: railRingTone(remainingPercent), tracks }];
    });
}

/**
 * The environment whose accounts the rail shows: the one the open thread (or its
 * draft) belongs to, so a remote thread reads that server's limits, else the
 * primary environment when no thread is open.
 */
export function resolveRailEnvironmentId(input: {
  readonly routeEnvironmentId: string | null;
  readonly draftEnvironmentId: EnvironmentId | null;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  return (
    (input.routeEnvironmentId as EnvironmentId | null) ??
    input.draftEnvironmentId ??
    input.primaryEnvironmentId
  );
}

type RailActivityThread = Parameters<typeof resolveSidebarThreadStatus>[0] & {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly archivedAt: string | null;
  readonly kind?: string | null | undefined;
};

/** Per project folder: threads waiting on the user (approval or input), and threads working. */
export type RailProjectActivity = { readonly needsYou: number; readonly working: number };

/**
 * Activity per project folder for the rail's project switcher, over the threads the sidebar
 * lists (not archived, no side chats). Folders with nothing live are left out.
 */
export function buildRailProjectActivity(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "projectKey" | "memberProjectRefs">>,
  threads: ReadonlyArray<RailActivityThread>,
): ReadonlyMap<string, RailProjectActivity> {
  const groupKeyByPhysicalKey = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByPhysicalKey.set(`${ref.environmentId}:${ref.projectId}`, group.projectKey);
    }
  }
  const activity = new Map<string, { needsYou: number; working: number }>();
  for (const thread of threads) {
    if (thread.archivedAt !== null || thread.kind === "sidechat") continue;
    const status = resolveSidebarThreadStatus(thread);
    const needsYou = status === "approval" || status === "input";
    if (!needsYou && status !== "working") continue;
    const groupKey = groupKeyByPhysicalKey.get(`${thread.environmentId}:${thread.projectId}`);
    if (groupKey === undefined) continue;
    const entry = activity.get(groupKey) ?? { needsYou: 0, working: 0 };
    if (needsYou) entry.needsYou += 1;
    else entry.working += 1;
    activity.set(groupKey, entry);
  }
  return activity;
}

/** The project button's accessible name: how many threads wait on the user, else whether one works. */
export function railProjectLabel(name: string, activity: RailProjectActivity | undefined): string {
  if (activity && activity.needsYou > 0) {
    return `${name}, ${activity.needsYou} ${activity.needsYou === 1 ? "needs" : "need"} you`;
  }
  if (activity && activity.working > 0) return `${name}, working`;
  return name;
}
