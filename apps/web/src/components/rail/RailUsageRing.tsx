import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { formatUsedPercent } from "../chat/composerUsageLimits.logic";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { useUsageRefreshOnOpen } from "../chat/useUsageRefreshOnOpen";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { TokenRows, TONE_FILL, UsagePaceLine, UsageTrack } from "../usage/UsageWindowRow";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatDuration, NO_USAGE_RECORDED_NOTICE } from "@t3tools/shared/usageLimits";
import { ResetCreditDialog, useResetCredit } from "../usage/UsageLimits";
import { type RailRingTone, type RailUsageRing } from "./appRail.logic";
import {
  buildRailUsageCardRows,
  railPlanLabel,
  usageProviderForDriver,
} from "./railUsageCard.logic";

const TONE_STROKE: Record<RailRingTone, string> = {
  healthy: "stroke-success",
  fair: "stroke-info",
  low: "stroke-warning",
  critical: "stroke-destructive",
};
// px in a 28 box. Two tracks sit 4.5 apart with thinner strokes and a smaller glyph.
const SINGLE = { size: 28, stroke: 2.5, icon: "size-4" };
const DOUBLE = { size: 30, stroke: 2.25, icon: "size-3.5" };
const TRACK_GAP = 4.5;

/** Remaining quota as static arcs around the provider glyph: weekly outside, session inside. No animation, no polling. */
function UsageRing({ ring }: { ring: RailUsageRing }) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[ring.entry.driverKind] ?? null;
  const box = ring.tracks.length > 1 ? DOUBLE : SINGLE;
  const outer = (box.size - box.stroke) / 2;
  const c = box.size / 2;
  return (
    <span className="relative inline-flex size-8 items-center justify-center">
      <svg
        viewBox={`0 0 ${box.size} ${box.size}`}
        className="absolute inset-0 size-8 -rotate-90"
        aria-hidden="true"
      >
        {ring.window === null ? (
          // Idle: limits read fine but no window is active yet. A static neutral ring, no arc.
          <circle
            cx={c}
            cy={c}
            r={outer}
            fill="none"
            strokeWidth={box.stroke}
            className="stroke-foreground/10"
          />
        ) : null}
        {ring.tracks.map((track, index) => (
          <g key={track.window.id}>
            <circle
              cx={c}
              cy={c}
              r={outer - index * TRACK_GAP}
              fill="none"
              strokeWidth={box.stroke}
              className="stroke-foreground/10"
            />
            {track.remainingPercent > 0 ? (
              <circle
                cx={c}
                cy={c}
                r={outer - index * TRACK_GAP}
                fill="none"
                strokeWidth={box.stroke}
                strokeLinecap="round"
                pathLength={100}
                strokeDasharray={`${track.remainingPercent} 100`}
                className={TONE_STROKE[track.tone]}
              />
            ) : null}
          </g>
        ))}
      </svg>
      {Icon ? <Icon className={cn(box.icon, "shrink-0")} aria-hidden /> : null}
    </span>
  );
}

/**
 * The card body. Mounted only while the card is open, so closed rings never probe the
 * provider. The reset-credit state and its confirm dialog live in the parent: the dialog
 * must outlive this card, which closes as soon as the pointer leaves it.
 */
function UsageCardBody({
  ring,
  environmentId,
  reset,
}: {
  ring: RailUsageRing;
  environmentId: EnvironmentId;
  reset: ReturnType<typeof useResetCredit>;
}) {
  const { openedAt } = useUsageRefreshOnOpen(environmentId, [ring.entry]);
  const limits = ring.entry.snapshot.usageLimits;
  const rows = limits ? buildRailUsageCardRows(limits.windows, openedAt) : [];
  const plan = railPlanLabel(ring.entry.snapshot.auth.label, ring.entry.displayName);
  const credits = limits?.resetCredits;
  const canRedeem = !!credits && credits.availableCount > 0 && credits.canRedeem !== false;
  const hasTokens = usageProviderForDriver(ring.entry.driverKind) !== null;
  const hasDetails = !!credits || !!limits?.resetCreditsUnavailableReason || hasTokens;
  return (
    <div data-rail-usage-card="" className="flex w-76 flex-col gap-3 rounded-[inherit] p-4 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-semibold text-sm">{ring.entry.displayName}</span>
        {plan ? (
          <span className="shrink-0 whitespace-nowrap text-muted-foreground">{plan}</span>
        ) : null}
      </div>
      {ring.tracks.length > 1 ? (
        <div className="flex items-center gap-3 text-muted-foreground">
          {ring.tracks.map((track, index) => (
            <span key={track.window.id} className="flex items-center gap-1.5">
              <span className={cn("size-1.5 rounded-full", TONE_FILL[track.tone])} aria-hidden />
              {track.window.label} · {index === 0 ? "outer" : "inner"}
            </span>
          ))}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <span className="text-muted-foreground">
          {ring.window === null ? NO_USAGE_RECORDED_NOTICE : "No plan limits reported."}
        </span>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="min-w-0 truncate font-medium text-sm" />}
                    >
                      {row.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{row.label}</TooltipPopup>
                  </Tooltip>
                  <span className="shrink-0 whitespace-nowrap tabular-nums">
                    {row.remainingText}
                  </span>
                </span>
                {row.reset ? (
                  <span className="shrink-0 whitespace-nowrap text-muted-foreground tabular-nums">
                    {row.reset}
                  </span>
                ) : null}
              </div>
              <UsageTrack row={row} />
              <UsagePaceLine row={row} />
            </li>
          ))}
        </ul>
      )}
      {hasDetails ? (
        <Collapsible>
          <CollapsibleTrigger className="group flex w-full items-center gap-1 text-muted-foreground outline-hidden hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
            <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
            Details
          </CollapsibleTrigger>
          <CollapsiblePanel>
            <div className="mt-2.5 flex flex-col gap-3 border-border border-t pt-3">
              {credits ? (
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="font-medium">Banked resets</span>
                    <span className="text-muted-foreground tabular-nums">
                      {credits.availableCount === 0
                        ? "None"
                        : `${credits.availableCount} available`}
                    </span>
                  </div>
                  <span className="text-muted-foreground">
                    Use when your 5-hour or weekly limit has 10% or less remaining.
                  </span>
                  {credits.availableCount > 0 ? (
                    <div className="flex items-center justify-between gap-3">
                      <span className="flex flex-col gap-0.5">
                        <span className="font-medium">Reset 1</span>
                        {credits.nextExpiresAt ? (
                          <span className="text-muted-foreground tabular-nums">
                            Expires in{" "}
                            {formatDuration(Date.parse(credits.nextExpiresAt) - openedAt)}
                          </span>
                        ) : null}
                      </span>
                      {canRedeem ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={reset.busy}
                          onClick={() => reset.setConfirming(true)}
                        >
                          {reset.busy ? "Using…" : "Use reset"}
                        </Button>
                      ) : null}
                    </div>
                  ) : null}
                  {reset.status ? <span>{reset.status}</span> : null}
                </div>
              ) : limits?.resetCreditsUnavailableReason ? (
                <span className="text-muted-foreground">
                  {limits.resetCreditsUnavailableReason}
                </span>
              ) : null}
              {hasTokens ? (
                <TokenRows driverKind={ring.entry.driverKind} openedAt={openedAt} />
              ) : null}
            </div>
          </CollapsiblePanel>
        </Collapsible>
      ) : null}
    </div>
  );
}

function UsageRingWithCard({
  ring,
  environmentId,
}: {
  ring: RailUsageRing;
  environmentId: EnvironmentId;
}) {
  const navigate = useNavigate();
  const reset = useResetCredit(environmentId, { instanceId: ring.entry.instanceId });
  return (
    <>
      <PreviewCard>
        <PreviewCardTrigger
          delay={150}
          closeDelay={80}
          render={
            <button
              type="button"
              aria-label={
                ring.window === null
                  ? `${ring.entry.displayName}, ${NO_USAGE_RECORDED_NOTICE}`
                  : `${ring.entry.displayName}, ${formatUsedPercent(ring.remainingPercent)} left`
              }
              onClick={() => void navigate({ to: "/usage" })}
              data-rail-usage-ring=""
              className="inline-flex size-9 items-center justify-center rounded-full outline-hidden transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <UsageRing ring={ring} />
        </PreviewCardTrigger>
        <PreviewCardPopup side="right" align="end" sideOffset={10}>
          <UsageCardBody ring={ring} environmentId={environmentId} reset={reset} />
        </PreviewCardPopup>
      </PreviewCard>
      <ResetCreditDialog
        open={reset.confirming}
        onOpenChange={reset.setConfirming}
        onConfirm={() => void reset.redeem()}
      />
    </>
  );
}

export function RailUsageRingButton({
  ring,
  environmentId,
}: {
  ring: RailUsageRing;
  environmentId: EnvironmentId;
}) {
  return <UsageRingWithCard ring={ring} environmentId={environmentId} />;
}
