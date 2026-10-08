import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { useMemo } from "react";

import { cn } from "~/lib/utils";
import { type RailRingTone } from "../rail/appRail.logic";
import { useUsage } from "../../state/usage";
import {
  buildRailUsageCardRows,
  railTokenRows,
  usageProviderForDriver,
  type RailUsageCardRow,
} from "../rail/railUsageCard.logic";

export const TONE_FILL: Record<RailRingTone, string> = {
  healthy: "bg-success",
  fair: "bg-info",
  low: "bg-warning",
  critical: "bg-destructive",
};

/** Remaining quota with a tick where an even pace would be by now (the OpenUsage/Synara pace marker). */
export function UsageTrack({ row, className }: { row: RailUsageCardRow; className?: string }) {
  const showMarker =
    row.markerPercent !== null && row.remainingPercent > 0 && row.remainingPercent < 100;
  return (
    <div
      role="meter"
      aria-label={`${row.label} remaining`}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(row.remainingPercent)}
      className={cn("relative h-1.5 w-full overflow-hidden rounded-full bg-muted", className)}
    >
      <div
        className={cn("h-full rounded-full", TONE_FILL[row.tone])}
        style={{ width: `${row.remainingPercent}%` }}
      />
      {showMarker ? (
        <div
          aria-hidden
          className="absolute inset-y-0 flex w-2 -translate-x-1/2 items-center justify-center"
          // The gap around the tick is the surface the track sits on: the card on the Usage page, the popover in the rail.
          style={{
            left: `${row.markerPercent}%`,
            backgroundColor: "var(--usage-track-gap, var(--popover))",
          }}
        >
          <span className={cn("h-full w-0.5 rounded-full", TONE_FILL[row.paceTone])} />
        </div>
      ) : null}
    </div>
  );
}

/** `11% in reserve · Lasts until reset`, or nothing when the window has no pace. */
export function UsagePaceLine({ row }: { row: RailUsageCardRow }) {
  if (!row.paceAmount && !row.paceEta) return null;
  return (
    <div className="flex items-baseline justify-between gap-3 text-muted-foreground tabular-nums">
      <span>{row.paceAmount ?? ""}</span>
      {row.paceEta ? <span>{row.paceEta}</span> : null}
    </div>
  );
}

/**
 * One window as Synara's Usage settings draw it: label with a pace dot, the
 * track, `27% left` against the reset, then reserve or deficit against the run-out.
 */
export function UsageWindowRow({ row }: { row: RailUsageCardRow }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      <span className="flex items-center gap-2 font-medium text-foreground">
        {row.label}
        <span aria-hidden className={cn("size-1.5 rounded-full", TONE_FILL[row.paceTone])} />
      </span>
      <UsageTrack row={row} />
      <div className="flex flex-col gap-1">
        <div className="flex items-baseline justify-between gap-3 text-muted-foreground tabular-nums">
          <span>{row.remainingText}</span>
          {row.reset ? <span>{row.reset}</span> : null}
        </div>
        <UsagePaceLine row={row} />
      </div>
    </div>
  );
}

/** Rows for a provider's windows, shortest first, with pace computed at `now`. */
export function usageWindowRows(windows: ReadonlyArray<ServerProviderUsageWindow>, now: number) {
  return buildRailUsageCardRows(windows, now);
}

/** Tokens and sessions for this provider over 24h, 7d and 30d, from the same report the Usage page reads. */
export function TokenRows({ driverKind, openedAt }: { driverKind: string; openedAt: number }) {
  const provider = usageProviderForDriver(driverKind);
  const [day, week, month] = useMemo(() => {
    const now = new Date(openedAt);
    return [makeWindow(1, now, "hour"), makeWindow(7, now), makeWindow(30, now)];
  }, [openedAt]);
  const d = useUsage(day).merged.providers;
  const w = useUsage(week).merged.providers;
  const m = useUsage(month).merged.providers;
  if (!provider) return null;
  const rows = railTokenRows(provider, [
    { label: "24h", providers: d },
    { label: "7d", providers: w },
    { label: "30d", providers: m },
  ]);
  return rows.map((row) => (
    <div key={row.label} className="flex flex-col gap-0.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-medium text-sm">{row.label}</span>
        <span className="text-muted-foreground tabular-nums">{row.tokens}</span>
      </div>
      <span className="text-muted-foreground tabular-nums">{row.sessions}</span>
    </div>
  ));
}
