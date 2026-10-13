import { useAtomValue } from "@effect/atom-react";
import * as Schema from "effect/Schema";
import {
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ComponentProps,
  type CSSProperties,
  type ReactNode,
} from "react";
import { ArrowLeftIcon, ArrowRightIcon } from "lucide-react";
import {
  useCanGoBack,
  useLocation,
  useNavigate,
  useParams,
  useRouter,
} from "@tanstack/react-router";

import { isElectron } from "../env";
import { getLocalStorageItem, removeLocalStorageItem } from "../hooks/useLocalStorage";
import {
  isRichTextBoldShortcut,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../keybindings";
import { isEditableFocused } from "../lib/editableFocus";
import { nextHistoryReach } from "../lib/historyReach";
import { isPreviewFocused } from "../lib/previewFocus";
import { isTerminalFocused } from "../lib/terminalFocus";
import { isModelPickerOpen } from "../modelPickerVisibility";
import { selectActiveRightPanel, useRightPanelStore } from "../rightPanelStore";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "../terminalUiStateStore";
import { resolveThreadRouteRef } from "../threadRoutes";
import { cn } from "../lib/utils";
import { primaryServerKeybindingsAtom } from "../state/server";
import {
  useClientSettings,
  useEnvironmentIdentificationMode,
  useLegacySidebarEnabled,
} from "../hooks/useSettings";
import { resolveShellTintColor } from "@t3tools/shared/shellTint";
import { resolveProjectGroupColor } from "../projectColor.logic";
import { projectAccentClassName } from "../projectIconColors";
import { useUiStateStore } from "../uiStateStore";
import { useSidebarProjectGroups } from "./sidebar/useSidebarProjectGroups";
import {
  PanelAnimationSuppressionProvider,
  usePanelAnimationSettings,
  usePanelNavigationSuppression,
} from "../panelAnimations";
import LegacyThreadSidebar from "./LegacySidebar";
import ThreadSidebar from "./Sidebar";
import { AppRail } from "./rail/AppRail";
import { SettingsSidebarNav } from "./settings/SettingsSidebarNav";
import { SidebarChromeHeader } from "./sidebar/SidebarChrome";
import { MainAppLocationTracker } from "./sidebar/mainAppLocation";
import { useSidebarStageBackdropVariant } from "./SidebarStageBackdrop";
import { useProjects } from "../state/entities";
import {
  APP_RAIL_WIDTH,
  resolveInitialThreadSidebarWidth,
  resolveThreadSidebarMaximumWidth,
  THREAD_MAIN_CONTENT_MIN_WIDTH,
  THREAD_SIDEBAR_MIN_WIDTH,
  THREAD_SIDEBAR_OVERLAY_BREAKPOINT,
  THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
} from "./threadSidebarWidth";
import {
  Sidebar,
  SidebarProvider,
  SidebarRail,
  SidebarTrigger,
  useSidebar,
  useSidebarVisibility,
} from "./ui/sidebar";
import { Button } from "./ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

function subscribeToViewportWidth(onChange: () => void): () => void {
  window.addEventListener("resize", onChange);
  return () => window.removeEventListener("resize", onChange);
}

function readViewportWidth(): number {
  return window.innerWidth;
}

function readInitialThreadSidebarWidth(): number {
  try {
    return resolveInitialThreadSidebarWidth(
      getLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY, Schema.Finite),
      window.innerWidth,
    );
  } catch (error) {
    console.error("Could not read persisted thread sidebar width.", error);
    return resolveInitialThreadSidebarWidth(null, window.innerWidth);
  }
}

function SidebarControl() {
  const usagePageOpen = useLocation({ select: (location) => location.pathname === "/usage" });
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const { toggleSidebar } = useSidebar();
  const isSidebarVisible = useSidebarVisibility();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );
  const shortcutLabel = shortcutLabelForCommand(keybindings, "sidebar.toggle", {
    context: { usagePageOpen },
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      if (
        isRichTextBoldShortcut(event) &&
        event.target instanceof HTMLElement &&
        event.target.closest('[data-composer-rich-text="true"]')
      ) {
        // The rich-text composer claims Mod+B for bold; the toggle stays
        // available everywhere else, including the plain-text composer.
        return;
      }
      if (
        resolveShortcutCommand(event, keybindings, { context: { usagePageOpen } }) !==
        "sidebar.toggle"
      )
        return;

      event.preventDefault();
      event.stopPropagation();
      toggleSidebar();
    };

    // Capture before focused editors consume commands such as Mod+B for rich-text formatting.
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [keybindings, toggleSidebar, usagePageOpen]);

  return (
    // The right-side layout controls carry mr-px (border compensation inside
    // the panel), so the trigger mirrors it: both clusters sit one extra pixel
    // off their edge and the titlebar reads symmetric.
    <div
      className="pointer-events-none fixed left-[var(--workspace-controls-left)] top-[var(--workspace-controls-top)] z-50 ml-px flex h-[var(--workspace-topbar-height)] items-center gap-1"
      data-sidebar-control=""
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTrigger
              // Over the stage artwork the trigger is a control on imagery, like the media
              // viewer's arrows; that variant positions itself, so the layout is reset here.
              variant={isSidebarVisible && stageBackdropVariant ? "media-navigation" : "ghost"}
              className={cn(
                "pointer-events-auto",
                isSidebarVisible && stageBackdropVariant && "relative top-auto translate-y-0",
              )}
              aria-label="Toggle main sidebar"
            />
          }
        />
        <TooltipPopup side="bottom">
          Toggle main sidebar{shortcutLabel ? ` (${shortcutLabel})` : ""}
        </TooltipPopup>
      </Tooltip>
      <HistoryArrows />
    </div>
  );
}

/**
 * Back and forward through the app's pages, beside the sidebar toggle from md up, so they stay
 * in the title bar whether the sidebar is open or not. Their keyboard commands are handled by
 * NavigationHistoryShortcuts.
 */
function HistoryArrows() {
  const router = useRouter();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const canGoBack = useCanGoBack();
  const [position, setPosition] = useState(() => {
    const index = router.history.location.state.__TSR_index;
    return { index, reach: index };
  });
  useEffect(
    () =>
      router.history.subscribe(({ location, action }) => {
        const index = location.state.__TSR_index;
        setPosition((current) => ({
          index,
          reach: nextHistoryReach(current.reach, action.type, index),
        }));
      }),
    [router.history],
  );
  const canGoForward = position.index < position.reach;
  const arrows = [
    {
      command: "navigation.back",
      label: "Go back",
      Icon: ArrowLeftIcon,
      enabled: canGoBack,
      go: () => router.history.back(),
    },
    {
      command: "navigation.forward",
      label: "Go forward",
      Icon: ArrowRightIcon,
      enabled: canGoForward,
      go: () => router.history.forward(),
    },
  ] as const;
  return (
    <span className="pointer-events-auto hidden items-center gap-0.5 [-webkit-app-region:no-drag] md:flex">
      {arrows.map(({ command, label, Icon, enabled, go }) => {
        const shortcut = shortcutLabelForCommand(keybindings, command);
        return (
          <Tooltip key={command}>
            <TooltipTrigger
              render={
                <Button
                  aria-label={label}
                  disabled={!enabled}
                  onClick={go}
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <Icon className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="bottom">
              {label}
              {shortcut ? ` (${shortcut})` : ""}
            </TooltipPopup>
          </Tooltip>
        );
      })}
    </span>
  );
}

// Moves through the app's route history like a browser's back/forward buttons.
function NavigationHistoryShortcuts() {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (
        event.target instanceof HTMLElement &&
        event.target.closest("[data-keybinding-capture]")
      ) {
        return;
      }
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: isTerminalFocused(),
          terminalOpen: routeThreadRef
            ? selectThreadTerminalUiState(
                useTerminalUiStateStore.getState().terminalUiStateByThreadKey,
                routeThreadRef,
              ).terminalOpen
            : false,
          previewFocus: isPreviewFocused(),
          previewOpen: routeThreadRef
            ? selectActiveRightPanel(useRightPanelStore.getState().byThreadKey, routeThreadRef) ===
              "preview"
            : false,
          editableFocus: isEditableFocused(event.target),
          modelPickerOpen: isModelPickerOpen(),
        },
      });
      if (command !== "navigation.back" && command !== "navigation.forward") return;

      event.preventDefault();
      event.stopPropagation();
      if (command === "navigation.back") window.history.back();
      else window.history.forward();
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, routeThreadRef]);

  return null;
}

/**
 * The colour the shell takes while the rail shows one project (and the setting allows it): the
 * project's colour, "accent" for a project without one (the theme accent, in CSS), else null for
 * the neutral sidebar. Set once as `--project-accent` on the shell root, so rows never re-render
 * for it.
 */
function useActiveProjectTint() {
  const projectGroups = useSidebarProjectGroups();
  const scopeKey = useUiStateStore((store) => store.sidebarProjectScopeKey);
  const followProjectColor = useClientSettings((settings) => settings.projectColorTint);
  const scopedGroup = useMemo(
    () => projectGroups.find((group) => group.projectKey === scopeKey) ?? null,
    [projectGroups, scopeKey],
  );
  const color = resolveShellTintColor({
    projectColor: scopedGroup ? resolveProjectGroupColor(scopedGroup) : null,
    followProjectColor,
  });
  return color ?? (scopedGroup !== null && followProjectColor ? "accent" : null);
}

// Settings swaps the thread sidebar out of the tree. Keep the lightweight
// project projection subscribed so returning to a draft never renders the
// zero-project state while the environment snapshot reconnects.
function ProjectProjectionRetention() {
  useProjects();
  return null;
}

export function AppSidebarLayout({ children }: { children: ReactNode }) {
  const navigate = useNavigate();
  const legacySidebarEnabled = useLegacySidebarEnabled();
  const projectTint = useActiveProjectTint();
  const { active: panelAnimationsActive, durationMs: panelAnimationDurationMs } =
    usePanelAnimationSettings();
  // Settings routes show the settings nav in place of whichever thread
  // sidebar is active.
  const pathname = useLocation({ select: (location) => location.pathname });
  const panelAnimationsSuppressed = usePanelNavigationSuppression(pathname);
  const routePanelAnimationsActive = panelAnimationsActive && !panelAnimationsSuppressed;
  const isOnSettings = pathname === "/settings" || pathname.startsWith("/settings/");
  const [sidebarWidth, setSidebarWidth] = useState(readInitialThreadSidebarWidth);
  // Subscribed rather than read once: the clamp must track live window size,
  // and a clamped drag ends with an unchanged width, which skips the re-render
  // that would otherwise refresh a render-time snapshot.
  const viewportWidth = useSyncExternalStore(subscribeToViewportWidth, readViewportWidth);
  const sidebarMaximumWidth = resolveThreadSidebarMaximumWidth(viewportWidth);
  const resetSidebarWidth = () => {
    try {
      removeLocalStorageItem(THREAD_SIDEBAR_WIDTH_STORAGE_KEY);
    } catch (error) {
      console.error("Could not clear persisted thread sidebar width.", error);
    }
    setSidebarWidth(resolveInitialThreadSidebarWidth(null, viewportWidth));
  };
  // Memoized: Sidebar re-clamps the stored width whenever this object changes.
  const resizable = useMemo<NonNullable<ComponentProps<typeof Sidebar>["resizable"]>>(
    () => ({
      maxWidth: sidebarMaximumWidth,
      minWidth: THREAD_SIDEBAR_MIN_WIDTH,
      // The wrapper spans the rail too, so main gets what is left after both.
      shouldAcceptWidth: ({ currentWidth, nextWidth, wrapper }) =>
        nextWidth <= currentWidth ||
        wrapper.clientWidth - APP_RAIL_WIDTH - nextWidth >= THREAD_MAIN_CONTENT_MIN_WIDTH,
      storageKey: THREAD_SIDEBAR_WIDTH_STORAGE_KEY,
      onResize: setSidebarWidth,
    }),
    [sidebarMaximumWidth],
  );
  const sidebarProviderStyle = {
    // Clamped at render so a narrowed window never squeezes main; the saved width is kept.
    "--sidebar-width": `${Math.min(sidebarWidth, sidebarMaximumWidth)}px`,
    "--panel-animation-duration": `${panelAnimationDurationMs}ms`,
  } as CSSProperties;

  useEffect(() => {
    const onMenuAction = window.desktopBridge?.onMenuAction;
    if (typeof onMenuAction !== "function") {
      return;
    }

    const unsubscribe = onMenuAction((action) => {
      if (action === "open-settings") {
        const isSettingsRoute = /^\/settings(\/|$)/.test(pathname);
        if (!isSettingsRoute) {
          void navigate({ to: "/settings" });
        }
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, [navigate, pathname]);

  return (
    <PanelAnimationSuppressionProvider value={panelAnimationsSuppressed}>
      {/* Layout-free: carries the active project's colour to the rail, sidebar and composer. */}
      <div
        className={cn(
          "contents",
          projectTint && projectTint !== "accent" && projectAccentClassName(projectTint),
        )}
        data-project-tint={projectTint ?? undefined}
      >
        <SidebarProvider
          className="h-dvh! min-h-0!"
          data-panel-animations={routePanelAnimationsActive ? "true" : "false"}
          // The macOS traffic-light layout keys on <html data-macos-window-controls>
          // (lib/windowControlsOverlay.ts), so a browser can preview it.
          data-app-rail-layout=""
          defaultOpen
          overlayBelow={THREAD_SIDEBAR_OVERLAY_BREAKPOINT}
          style={sidebarProviderStyle}
        >
          <ProjectProjectionRetention />
          <AppRail />
          <Sidebar
            side="left"
            collapsible="offcanvas"
            data-app-sidebar=""
            role="navigation"
            aria-label={isOnSettings ? "Settings" : "Threads"}
            resizable={resizable}
          >
            {isOnSettings ? (
              <>
                <SidebarChromeHeader isElectron={isElectron} />
                <SettingsSidebarNav pathname={pathname} />
              </>
            ) : legacySidebarEnabled ? (
              <LegacyThreadSidebar />
            ) : (
              <ThreadSidebar />
            )}
            <SidebarRail onDoubleClick={resetSidebarWidth} />
          </Sidebar>
          {children}
          <SidebarControl />
          <NavigationHistoryShortcuts />
          <MainAppLocationTracker />
        </SidebarProvider>
      </div>
    </PanelAnimationSuppressionProvider>
  );
}
