import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { FolderIcon, SettingsIcon, SmartphoneIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { settlePromise } from "@t3tools/client-runtime/state/runtime";

import { cn } from "~/lib/utils";
import { useAppSettingsRoute } from "./useAppRailNavigation";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { readLocalApi } from "../../localApi";
import { resolveProjectGroupColor } from "../../projectColor.logic";
import { projectAccentClassName } from "../../projectIconColors";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import type { SidebarProjectSnapshot } from "../../sidebarProjectGrouping";
import { useThreadShells } from "../../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS, serverEnvironment } from "../../state/server";
import { useUiStateStore } from "../../uiStateStore";
import { openConnectPhoneDialog } from "../connectPhone/ConnectPhoneDialog";
import { openProjectColorDialog } from "../ProjectColorPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { useSidebarProjectGroups } from "../sidebar/useSidebarProjectGroups";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  buildRailProjectActivity,
  buildRailUsageRings,
  railProjectLabel,
  resolveRailEnvironmentId,
} from "./appRail.logic";
import { RailUsageRingButton } from "./RailUsageRing";

function RailButton(props: {
  label: string;
  onClick: () => void;
  children: React.ReactNode;
  active?: boolean;
  /** A toggle that stays lit while on (the selected project scope); colored icons hide `active`. */
  pressed?: boolean;
  /** Tooltip text when the accessible label carries more (a project's waiting count). */
  tooltip?: string;
  onContextMenu?: (event: React.MouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant={props.active || props.pressed ? "ghost" : "ghost-muted"}
            size="icon"
            aria-label={props.label}
            aria-pressed={props.pressed}
            data-pressed={props.pressed ? "" : undefined}
            onClick={props.onClick}
            onContextMenu={props.onContextMenu}
          />
        }
      >
        {props.children}
      </TooltipTrigger>
      <TooltipPopup side="right">{props.tooltip ?? props.label}</TooltipPopup>
    </Tooltip>
  );
}

/** Picking the scoped project again, or All projects (null), shows every project. */
function toggleRailProjectScope(projectKey: string | null) {
  const store = useUiStateStore.getState();
  store.setSidebarProjectScopeKey(
    projectKey === null || store.sidebarProjectScopeKey === projectKey ? null : projectKey,
  );
}

const RailProjectButton = memo(function RailProjectButton(props: {
  project: SidebarProjectSnapshot;
  selected: boolean;
  needsYou: number;
  working: number;
}) {
  const { project, needsYou, working } = props;
  const navigate = useNavigate();
  const projectColor = resolveProjectGroupColor(project);
  return (
    <RailButton
      label={railProjectLabel(project.displayName, { needsYou, working })}
      tooltip={project.displayName}
      pressed={props.selected}
      onClick={() => toggleRailProjectScope(project.projectKey)}
      onContextMenu={(event) => {
        event.preventDefault();
        const position = { x: event.clientX, y: event.clientY };
        void (async () => {
          const api = readLocalApi();
          if (!api) return;
          const clicked = await settlePromise(() =>
            api.contextMenu.show<"project-color" | "project-settings">(
              [
                { id: "project-color", label: "Project color…" },
                { id: "project-settings", label: "Project settings", icon: "settings" },
              ],
              position,
            ),
          );
          if (clicked._tag === "Failure") return;
          if (clicked.value === "project-color") openProjectColorDialog(project.projectKey);
          if (clicked.value === "project-settings") {
            void navigate({
              to: "/projects/$projectKey",
              params: { projectKey: project.projectKey },
            });
          }
        })();
      }}
    >
      {projectColor ? (
        <span
          className={cn(
            "flex rounded-md p-0.5 ring-2 ring-(--project-accent)",
            projectAccentClassName(projectColor),
          )}
        >
          <ProjectFavicon project={project} className="size-4" />
        </span>
      ) : (
        <ProjectFavicon project={project} className="size-5" />
      )}
      {needsYou > 0 ? (
        <span
          aria-hidden
          className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 font-semibold text-3xs text-background tabular-nums leading-none ring-2 ring-sidebar"
        >
          {needsYou}
        </span>
      ) : working > 0 ? (
        <span
          aria-hidden
          className="absolute right-0.5 bottom-0.5 size-1.5 rounded-full bg-muted-foreground"
        />
      ) : null}
    </RailButton>
  );
});

/**
 * The sidebar's project scope as one button per project folder, in the scope menu's order. It
 * only narrows the thread sidebar (collapsed or not), with amber counts for threads waiting on
 * the user and a static dot for working ones.
 */
const RailProjectSwitcher = memo(function RailProjectSwitcher() {
  const projectGroups = useSidebarProjectGroups();
  const threads = useThreadShells();
  const scopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const activityByProject = useMemo(
    () => buildRailProjectActivity(projectGroups, threads),
    [projectGroups, threads],
  );
  if (projectGroups.length === 0) return null;
  // A scope whose project is gone reads as All until the sidebar clears it.
  const selectedKey = projectGroups.some((group) => group.projectKey === scopeKey)
    ? scopeKey
    : null;
  return (
    <>
      <RailButton
        label="All projects"
        pressed={selectedKey === null}
        onClick={() => toggleRailProjectScope(null)}
      >
        <FolderIcon />
      </RailButton>
      {projectGroups.map((project) => {
        const activity = activityByProject.get(project.projectKey);
        return (
          <RailProjectButton
            key={project.projectKey}
            project={project}
            selected={selectedKey === project.projectKey}
            needsYou={activity?.needsYou ?? 0}
            working={activity?.working ?? 0}
          />
        );
      })}
    </>
  );
});

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
  // Phones hide the rail; skip the switcher's thread scan there.
  const railVisible = useMediaQuery("md");
  return (
    <nav
      aria-label="App rail"
      data-app-rail=""
      className="relative z-20 hidden w-12 shrink-0 flex-col items-center border-sidebar-border border-r bg-sidebar pb-2 text-sidebar-foreground md:flex"
    >
      <div className="h-[var(--workspace-topbar-height)] w-full shrink-0 drag-region" />
      {/* Many projects scroll here; the bottom group never leaves the screen. */}
      <div className="flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto overscroll-contain py-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {railVisible ? <RailProjectSwitcher /> : null}
      </div>
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
