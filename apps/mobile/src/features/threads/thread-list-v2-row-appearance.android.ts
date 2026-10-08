import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "monospace";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-6 py-2.5";
export const THREAD_LIST_V2_ROW_DIVIDERS = false;
/** Clean list: the provider glyph leads the title instead of trailing the meta line. */
export const THREAD_LIST_V2_PROVIDER_LEADS_TITLE = true;

export const selectedThreadRowColors = {
  foregroundClassName: "text-thread-selected-foreground",
  mutedForegroundClassName: "text-thread-selected-foreground-muted",
  iconTintClassName: "accent-thread-selected-foreground",
  mutedIconTintClassName: "accent-thread-selected-foreground-muted",
};

export function getThreadListV2NewBranchMenuTitle(branch: string) {
  return `New thread on ${branch}`;
}

export function getThreadListV2RowAppearance(
  theme: MobileThemeVariables,
  sidebarPane: boolean,
  selected: boolean,
  /** Inside a Home folder card: a flat row, the card draws the box. */
  _inFolderCard = false,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  // Clean list: Home rows sit flat on the screen; the sidebar keeps its pills.
  const backgroundColor = theme[sidebarPane ? "--color-drawer" : "--color-screen"];
  const radius = sidebarPane ? 20 : 0;
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : backgroundColor,
    borderRadius: radius,
  };
  const swipeContainerStyle: ViewStyle = sidebarPane
    ? { borderRadius: radius, overflow: "hidden", marginHorizontal: 8, marginVertical: 2 }
    : { overflow: "hidden" };

  return {
    className: undefined,
    interactionClassName: sidebarPane ? "bg-thread-hover" : "bg-row-hover",
    interactionOpacity: selected ? 0 : 1,
    foregroundClassName: sidebarPane ? "text-drawer-foreground" : "text-foreground",
    mutedForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-muted",
    tertiaryForegroundClassName: sidebarPane
      ? "text-drawer-foreground-muted"
      : "text-foreground-tertiary",
    mutedIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-muted",
    tertiaryIconTintClassName: sidebarPane
      ? "accent-drawer-foreground-muted"
      : "accent-foreground-tertiary",
    style,
    cardStyle: sidebarPane ? { ...style, paddingHorizontal: 12, paddingVertical: 10 } : style,
    swipeContainerStyle,
    swipeBackgroundColor: backgroundColor,
    providerIconSurfaceColor: selected ? selectedBackgroundColor : backgroundColor,
  };
}
