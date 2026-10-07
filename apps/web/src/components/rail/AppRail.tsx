import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { SettingsIcon, SmartphoneIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { useAppSettingsRoute } from "./useAppRailNavigation";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { openConnectPhoneDialog } from "../connectPhone/ConnectPhoneDialog";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { buildRailUsageRings, resolveRailEnvironmentId } from "./appRail.logic";
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

/** Rings for the accounts of one environment; no polling, so a thread switch only re-derives. */
const RailUsageRings = memo(function RailUsageRings(props: { environmentId: EnvironmentId }) {
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ??
    EMPTY_SERVER_PROVIDERS;
  const settings = useEnvironmentSettings(props.environmentId);
  const rings = useMemo(
    () =>
      buildRailUsageRings(
        sortProviderInstanceEntries(
          applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
        ),
      ),
    [providers, settings],
  );
  return rings.map((ring) => (
    <RailUsageRingButton
      key={`${props.environmentId}:${ring.entry.instanceId}`}
      ring={ring}
      environmentId={props.environmentId}
    />
  ));
});

/** The open thread's environment, so a remote thread shows that server's limits. */
function useRailEnvironmentId(): EnvironmentId | null {
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => params.environmentId ?? null,
  });
  const draftId = useParams({ strict: false, select: (params) => params.draftId ?? null });
  const draftEnvironmentId = useComposerDraftStore((store) =>
    draftId === null ? null : (store.getDraftSession(DraftId.make(draftId))?.environmentId ?? null),
  );
  return resolveRailEnvironmentId({
    routeEnvironmentId,
    draftEnvironmentId,
    primaryEnvironmentId: usePrimaryEnvironmentId(),
  });
}

/**
 * The slim always-visible rail at the far left (desktop and web; phones keep the sidebar sheet).
 * The sidebar toggle is the fixed titlebar control (AppSidebarLayout) that already sits over
 * the rail's top edge.
 */
export const AppRail = memo(function AppRail() {
  const railEnvironmentId = useRailEnvironmentId();
  const { onSettings, openSettings } = useAppSettingsRoute();
  const onPullRequests = useLocation({
    select: (location) => location.pathname.startsWith("/pull-requests"),
  });
  return (
    <nav
      aria-label="App rail"
      data-app-rail=""
      className="relative z-20 hidden w-12 shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar pb-2 text-sidebar-foreground md:flex"
    >
      <div className="h-[var(--workspace-topbar-height)] w-full shrink-0 drag-region" />
      <div className="flex-1" />
      <div className="flex flex-col items-center gap-1 pb-2">
        {railEnvironmentId ? <RailUsageRings environmentId={railEnvironmentId} /> : null}
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
