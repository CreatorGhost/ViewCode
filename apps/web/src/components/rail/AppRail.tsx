import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChartNoAxesColumnIcon, EllipsisIcon, SettingsIcon, SmartphoneIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { cn } from "~/lib/utils";
import { useAppSettingsRoute } from "./useAppRailNavigation";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "../../state/server";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { PROVIDER_ICON_BY_PROVIDER } from "../chat/providerIconUtils";
import {
  formatUsageReset,
  formatUsedPercent,
  orderUsageWindows,
  shortPlanName,
} from "../chat/composerUsageLimits.logic";
import { useUsageRefreshOnOpen } from "../chat/useUsageRefreshOnOpen";
import { openConnectPhoneDialog } from "../connectPhone/ConnectPhoneDialog";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "../ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildRailUsageRings, type RailRingTone, type RailUsageRing } from "./appRail.logic";

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
        {remaining !== null && remaining > 0 && ring.tone ? (
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

/** Mounted only while the card is open, so closed rings never probe the provider. */
function UsageRingCard({ ring, environmentId }: { ring: RailUsageRing; environmentId: EnvironmentId }) {
  const { openedAt } = useUsageRefreshOnOpen(environmentId, [ring.entry]);
  const limits = ring.entry.snapshot.usageLimits;
  const windows = limits ? orderUsageWindows(limits.windows) : [];
  const plan = ring.entry.snapshot.auth.label;
  return (
    <div className="flex w-64 flex-col gap-2.5 p-3">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-semibold text-sm">{ring.entry.displayName}</span>
        <span className="truncate text-muted-foreground text-xs">
          {plan ? `Plan usage limits · ${shortPlanName(plan)}` : "Plan usage limits"}
        </span>
      </div>
      {windows.length === 0 ? (
        <span className="text-muted-foreground text-xs">No plan limits reported.</span>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {windows.map((window) => {
            const remaining = Math.max(0, 100 - window.usedPercent);
            const tone = buildRailUsageRings([ring.entry])[0]?.window?.id === window.id;
            const reset = formatUsageReset(window.resetsAt, openedAt);
            return (
              <li key={window.id} className="flex flex-col gap-1">
                <div className="flex items-baseline gap-2 text-xs">
                  <span className={cn("min-w-0 flex-1 truncate", tone && "font-medium")}>
                    {window.label}
                  </span>
                  {reset ? (
                    <span className="shrink-0 text-muted-foreground tabular-nums">{reset}</span>
                  ) : null}
                  <span className="w-12 shrink-0 text-right tabular-nums">
                    {formatUsedPercent(remaining)} left
                  </span>
                </div>
                <div
                  role="meter"
                  aria-label={`${window.label} remaining`}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(remaining)}
                  className="h-1 overflow-hidden rounded-full bg-foreground/10"
                >
                  <div
                    className={cn(
                      "h-full rounded-full",
                      TONE_FILL[
                        remaining >= 50
                          ? "healthy"
                          : remaining >= 25
                            ? "fair"
                            : remaining >= 10
                              ? "low"
                              : "critical"
                      ],
                    )}
                    style={{ width: `${remaining}%` }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function UsageRingButton({ ring }: { ring: RailUsageRing }) {
  const navigate = useNavigate();
  const environmentId = usePrimaryEnvironmentId();
  const label =
    ring.remainingPercent === null
      ? `${ring.entry.displayName} usage`
      : `${ring.entry.displayName}, ${formatUsedPercent(ring.remainingPercent)} left`;
  return (
    <PreviewCard>
      <PreviewCardTrigger
        delay={150}
        closeDelay={80}
        render={
          <button
            type="button"
            aria-label={label}
            onClick={() => void navigate({ to: "/usage" })}
            className="inline-flex size-9 items-center justify-center rounded-full outline-hidden transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          />
        }
      >
        <UsageRing ring={ring} />
      </PreviewCardTrigger>
      <PreviewCardPopup side="right" align="end" sideOffset={10}>
        {environmentId ? <UsageRingCard ring={ring} environmentId={environmentId} /> : null}
      </PreviewCardPopup>
    </PreviewCard>
  );
}

function RailButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.active ? "ghost" : "ghost-muted"}
            size="icon"
            aria-label={props.label}
            onClick={props.onClick}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.label}</TooltipPopup>
    </Tooltip>
  );
}

const RailMoreMenu = memo(function RailMoreMenu() {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger render={<Button variant="ghost-muted" size="icon" aria-label="More" />} />
          }
        >
          <EllipsisIcon />
        </TooltipTrigger>
        <TooltipPopup side="right">More</TooltipPopup>
      </Tooltip>
      <MenuPopup side="right" align="end" sideOffset={10}>
        {pullRequestsSupported ? (
          <MenuItem
            onClick={() =>
              void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
            }
          >
            <PullRequestGlyph.pullRequest />
            Pull Requests
          </MenuItem>
        ) : null}
        <MenuItem onClick={() => void navigate({ to: "/usage" })}>
          <ChartNoAxesColumnIcon />
          Usage
        </MenuItem>
        <MenuItem onClick={() => openConnectPhoneDialog()}>
          <SmartphoneIcon />
          Connect phone
        </MenuItem>
      </MenuPopup>
    </Menu>
  );
});

/**
 * The slim always-visible rail at the far left (desktop and web; phones keep the sidebar sheet).
 * The sidebar toggle is the fixed titlebar control (AppSidebarLayout) that already sits over
 * the rail's top edge.
 */
export const AppRail = memo(function AppRail() {
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = useAtomValue(primaryServerSettingsAtom);
  const { onSettings, openSettings } = useAppSettingsRoute();
  const rings = useMemo(
    () =>
      buildRailUsageRings(
        sortProviderInstanceEntries(
          applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
        ),
      ),
    [providers, settings],
  );
  return (
    <nav
      aria-label="App rail"
      data-app-rail=""
      className="relative z-20 hidden w-12 shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar pb-2 text-sidebar-foreground md:flex"
    >
      <div className="h-[var(--workspace-topbar-height)] w-full shrink-0 drag-region" />
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-1 pb-2">
        {rings.map((ring) => (
          <UsageRingButton key={ring.entry.instanceId} ring={ring} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        <RailButton label="Settings" active={onSettings} onClick={openSettings}>
          <SettingsIcon />
        </RailButton>
        <RailMoreMenu />
      </div>
    </nav>
  );
});
