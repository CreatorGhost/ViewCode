import { ArrowLeftIcon, ChartNoAxesColumnIcon, SettingsIcon, SmartphoneIcon } from "lucide-react";
import type { ReactNode } from "react";
import { memo, useCallback } from "react";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";

import { useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { useEnvironments } from "../../state/environments";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  resolveThemeEnvironmentIdentificationMode,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { T3Wordmark } from "../T3Wordmark";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useOpenPullRequests } from "../pullRequest/useOpenPullRequests";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { openConnectPhoneDialog } from "../connectPhone/ConnectPhoneDialog";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
  actions,
}: {
  isElectron: boolean;
  /** Controls at the row's end, such as the thread sidebar's New menu. */
  actions?: ReactNode;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = resolveThemeEnvironmentIdentificationMode(
    useEnvironmentIdentificationMode(),
  );
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode === "artwork",
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div className="@container/sidebar-header relative flex shrink-0 flex-col">
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      {/* The title bar: the window controls, then the sidebar toggle and history arrows, which
          float here from AppSidebarLayout so they stay put when the sidebar collapses. */}
      <div
        className={cn(
          "relative h-[var(--workspace-topbar-height)] shrink-0 max-md:hidden",
          isElectron && "drag-region",
        )}
      />
      <div className="relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-2 pl-3 md:h-9">
        <SidebarTrigger
          // Over the stage artwork: the media viewer's control-on-imagery treatment.
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto z-10 translate-y-0 md:hidden"
        />
        <SidebarBrand onBackdrop={backdropVariant !== null} />
        {pillLabel ? (
          <Badge
            className="relative z-10 hidden @[15rem]/sidebar-header:inline-flex"
            data-environment-identification="pill"
            size="sm"
            variant="secondary"
          >
            {pillLabel}
          </Badge>
        ) : null}
        {actions ? (
          <div className="relative z-10 ml-auto flex shrink-0 items-center gap-1">{actions}</div>
        ) : null}
      </div>
    </div>
  );
});

function SidebarBrand({ onBackdrop }: { onBackdrop: boolean }) {
  return (
    <Link
      aria-label="Go to threads"
      className={cn(
        "relative z-10 hidden h-7 w-fit min-w-0 shrink-0 items-center gap-1.5 overflow-hidden rounded-md outline-hidden ring-ring focus-visible:ring-2 md:flex",
        onBackdrop ? "text-white" : "text-foreground",
      )}
      to="/"
    >
      <T3Wordmark className="h-5 w-auto shrink-0" aria-hidden />
      {/* Center the visible capitals, without the font's ascender/descender space. */}
      <span className="truncate text-sm font-semibold tracking-tight [text-box:trim-both_cap_alphabetic]">
        ViewCode
      </span>
    </Link>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    // The app rail carries these on desktop; the mobile sheet has no rail.
    <SidebarMenuItem className="shrink-0 md:hidden">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

export const SidebarUtilityMenu = memo(function SidebarUtilityMenu() {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const { environments } = useEnvironments();
  // The page reads every connected server, so one of them offering pull requests is enough for
  // the link to lead somewhere.
  const pullRequestsSupported = environments.some(
    (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
  );
  const closeMobileSidebar = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
  }, [isMobile, setOpenMobile]);
  const openPullRequests = useOpenPullRequests();
  const handlePullRequestsClick = useCallback(() => {
    closeMobileSidebar();
    void openPullRequests();
  }, [closeMobileSidebar, openPullRequests]);
  const handleSettingsClick = useCallback(() => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  }, [closeMobileSidebar, navigate]);

  const handleUsageClick = useCallback(() => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  }, [isMobile, navigate, setOpenMobile]);

  const handleBackClick = useCallback(() => {
    closeMobileSidebar();
    void navigateToMainApp();
  }, [closeMobileSidebar, navigateToMainApp]);

  return (
    <SidebarMenu className="flex-row items-center">
      {isOnUtilityPage ? (
        // Desktop has the header Back button; the mobile sheet keeps this one.
        <SidebarMenuItem className="min-w-0 flex-1 md:hidden">
          <SidebarMenuButton onClick={handleBackClick}>
            <ArrowLeftIcon />
            <span>Back</span>
          </SidebarMenuButton>
        </SidebarMenuItem>
      ) : (
        <>
          <SidebarUtilityItem
            icon={<SettingsIcon />}
            label="Settings"
            onClick={handleSettingsClick}
          />
          {pullRequestsSupported ? (
            <SidebarUtilityItem
              icon={<PullRequestGlyph.pullRequest />}
              label="Pull Requests"
              onClick={handlePullRequestsClick}
            />
          ) : null}
          <SidebarUtilityItem
            icon={<ChartNoAxesColumnIcon />}
            label="Usage"
            onClick={handleUsageClick}
          />
          <SidebarUtilityItem
            icon={<SmartphoneIcon />}
            label="Connect phone"
            onClick={() => {
              closeMobileSidebar();
              openConnectPhoneDialog();
            }}
          />
        </>
      )}
      <SidebarUpdatePill />
    </SidebarMenu>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter() {
  return (
    <SidebarFooter>
      <SidebarThreadUndoNotice />
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu />
    </SidebarFooter>
  );
});
