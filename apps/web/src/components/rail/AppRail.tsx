import { useAtomValue } from "@effect/atom-react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SettingsIcon, SmartphoneIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useAppSettingsRoute } from "./useAppRailNavigation";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom, primaryServerSettingsAtom } from "../../state/server";
import { useEnvironments } from "../../state/environments";
import { openConnectPhoneDialog } from "../connectPhone/ConnectPhoneDialog";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildRailUsageRings } from "./appRail.logic";
import { RailUsageRingButton } from "./RailUsageRing";

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

/** Pull Requests is the only destination the rings and Settings don't already cover. */
const RailPullRequestsButton = memo(function RailPullRequestsButton(props: { active: boolean }) {
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  if (!pullRequestsSupported) return null;
  return (
    <RailButton
      label="Pull Requests"
      active={props.active}
      onClick={() =>
        void navigate({ to: "/pull-requests", search: readPullRequestListPreferences() })
      }
    >
      <PullRequestGlyph.pullRequest />
    </RailButton>
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
  const onPullRequests = useLocation({
    select: (location) => location.pathname.startsWith("/pull-requests"),
  });
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
          <RailUsageRingButton key={ring.entry.instanceId} ring={ring} />
        ))}
      </div>
      <div className="flex flex-col items-center gap-1">
        <RailButton label="Settings" active={onSettings} onClick={openSettings}>
          <SettingsIcon />
        </RailButton>
        <RailPullRequestsButton active={onPullRequests} />
        <RailButton label="Connect phone" onClick={() => openConnectPhoneDialog()}>
          <span data-rail-phone="" className="contents">
            <SmartphoneIcon />
          </span>
        </RailButton>
      </div>
    </nav>
  );
});
