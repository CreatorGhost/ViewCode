import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { formatUsedPercent } from "../chat/composerUsageLimits.logic";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import { useUsageRefreshOnOpen } from "../chat/useUsageRefreshOnOpen";
import { Button } from "../ui/button";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ResetCreditDialog, resetCreditsSummary, useResetCredit } from "../usage/UsageLimits";
import { type RailRingTone, type RailUsageRing } from "./appRail.logic";
import { buildRailUsageCardRows, railPlanLabel } from "./railUsageCard.logic";

const RING_RADIUS = 12;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

const TONE_STROKE: Record<RailRingTone, string> = {
  healthy: "stroke-success",
  fair: "stroke-info",
  low: "stroke-warning",
  critical: "stroke-destructive",
};
const TONE_FILL: Record<RailRingTone, string> = {
  healthy: "bg-success",
  fair: "bg-info",
  low: "bg-warning",
  critical: "bg-destructive",
};

/** Remaining quota as a static arc around the provider glyph; no animation, no polling. */
function UsageRing({ ring }: { ring: RailUsageRing }) {
  const Icon = PROVIDER_ICON_BY_PROVIDER[ring.entry.driverKind] ?? null;
  const remaining = ring.remainingPercent;
  return (
    <span className="relative inline-flex size-8 items-center justify-center">
      <svg viewBox="0 0 28 28" className="absolute inset-0 size-8" aria-hidden="true">
        <circle
          cx="14"
          cy="14"
          r={RING_RADIUS}
          fill="none"
          strokeWidth="2.5"
          className="stroke-foreground/10"
        />
        {remaining > 0 ? (
          <circle
            cx="14"
            cy="14"
            r={RING_RADIUS}
            fill="none"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={`${(RING_CIRCUMFERENCE * remaining) / 100} ${RING_CIRCUMFERENCE}`}
            transform="rotate(-90 14 14)"
            className={TONE_STROKE[ring.tone]}
          />
        ) : null}
      </svg>
      {Icon ? <Icon className="size-4 shrink-0" aria-hidden /> : null}
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
  return (
    <div data-rail-usage-card="" className="flex w-76 flex-col gap-3 rounded-[inherit] p-4 text-xs">
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-semibold text-sm">{ring.entry.displayName}</span>
        {plan ? (
          <span className="shrink-0 whitespace-nowrap text-sidebar-muted-foreground">{plan}</span>
        ) : null}
      </div>
      {rows.length === 0 ? (
        <span className="text-sidebar-muted-foreground">No plan limits reported.</span>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <li key={row.id} className="flex flex-col gap-1.5">
              <div className="flex items-baseline justify-between gap-3">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 truncate" />}>
                      {row.label}
                    </TooltipTrigger>
                    <TooltipPopup side="top">{row.label}</TooltipPopup>
                  </Tooltip>
                  <span className="shrink-0 whitespace-nowrap font-medium tabular-nums">
                    {row.remainingText}
                  </span>
                </span>
                {row.reset ? (
                  <span className="shrink-0 whitespace-nowrap text-sidebar-muted-foreground tabular-nums">
                    {row.reset}
                  </span>
                ) : null}
              </div>
              <div
                role="meter"
                aria-label={`${row.label} remaining`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(row.remainingPercent)}
                className="h-1 w-full overflow-hidden rounded-full bg-sidebar-foreground/10"
              >
                <div
                  className={cn("h-full rounded-full", TONE_FILL[row.tone])}
                  style={{ width: `${row.remainingPercent}%` }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
      {credits || limits?.resetCreditsUnavailableReason ? (
        <div className="border-sidebar-border border-t pt-2.5">
          <Collapsible>
            <CollapsibleTrigger className="group flex w-full items-center gap-1 text-sidebar-muted-foreground outline-hidden hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <ChevronRightIcon className="size-3.5 transition-transform group-data-panel-open:rotate-90" />
              Details
            </CollapsibleTrigger>
            <CollapsiblePanel>
              <div className="flex flex-col gap-2 pt-2.5">
                {credits ? (
                  <div className="flex items-center justify-between gap-3">
                    <span className="min-w-0 text-sidebar-muted-foreground tabular-nums">
                      {resetCreditsSummary(credits, openedAt, true)}
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
                ) : (
                  <span className="text-sidebar-muted-foreground">
                    {limits?.resetCreditsUnavailableReason}
                  </span>
                )}
                {reset.status ? <span>{reset.status}</span> : null}
              </div>
            </CollapsiblePanel>
          </Collapsible>
        </div>
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
              aria-label={`${ring.entry.displayName}, ${formatUsedPercent(ring.remainingPercent)} left`}
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
