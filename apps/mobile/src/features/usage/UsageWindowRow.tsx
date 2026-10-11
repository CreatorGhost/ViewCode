import type { RailRingTone, RailUsageCardRow } from "@t3tools/shared/usagePace";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";

// The theme has no solid success/info fills, so these use the palette classes the app already uses for status.
const TONE_FILL: Record<RailRingTone, string> = {
  healthy: "bg-emerald-500",
  fair: "bg-sky-500",
  low: "bg-amber-500",
  critical: "bg-red-500",
};

/**
 * One window as the desktop Usage page draws it: label with a pace dot, the
 * track filled to quota left with a tick where an even pace would be, then
 * `27% left` against the reset and reserve or deficit against the run-out.
 * `gapClassName` is the surface the row sits on, so the gap around the tick
 * matches it.
 */
export function UsageWindowRow({
  row,
  gapClassName = "bg-card",
}: {
  readonly row: RailUsageCardRow;
  readonly gapClassName?: string;
}) {
  const showMarker =
    row.markerPercent !== null && row.remainingPercent > 0 && row.remainingPercent < 100;
  return (
    <View
      className="gap-2"
      accessible
      accessibilityLabel={[row.label, row.remainingText, row.reset, row.paceAmount, row.paceEta]
        .filter(Boolean)
        .join(", ")}
    >
      <View className="flex-row items-center gap-2">
        <Text className="text-sm font-t3-medium text-foreground">{row.label}</Text>
        <View className={cn("size-1.5 rounded-full", TONE_FILL[row.paceTone])} />
      </View>
      <View className="h-1.5 overflow-hidden rounded-full bg-subtle-strong">
        <View
          className={cn("h-full rounded-full", TONE_FILL[row.tone])}
          style={{ width: `${row.remainingPercent}%` }}
        />
        {showMarker ? (
          <View
            className={cn("absolute inset-y-0 w-2 items-center", gapClassName)}
            style={{ left: `${row.markerPercent}%`, marginLeft: -4 }}
          >
            <View className={cn("h-full w-0.5 rounded-full", TONE_FILL[row.paceTone])} />
          </View>
        ) : null}
      </View>
      <View className="gap-1">
        <View className="flex-row items-baseline justify-between gap-3">
          <Text className="text-xs tabular-nums text-foreground-muted">{row.remainingText}</Text>
          {row.reset ? (
            <Text className="text-xs tabular-nums text-foreground-muted">{row.reset}</Text>
          ) : null}
        </View>
        {row.paceAmount || row.paceEta ? (
          <View className="flex-row items-baseline justify-between gap-3">
            <Text className="text-xs tabular-nums text-foreground-muted">
              {row.paceAmount ?? ""}
            </Text>
            {row.paceEta ? (
              <Text className="text-xs tabular-nums text-foreground-muted">{row.paceEta}</Text>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}
