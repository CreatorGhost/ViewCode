import type { ViewStyle } from "react-native";
import type { MobileThemeVariables } from "../../lib/mobileTheme";

export const THREAD_LIST_V2_MONO_FONT = "monospace";
export const THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME = "px-3 py-2.5";
export const THREAD_LIST_V2_ROW_DIVIDERS = false;

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
  inFolderCard = false,
) {
  const selectedBackgroundColor = theme["--color-thread-selected"];
  // Refined: list rows are squared cards on the screen; the sidebar stays flat.
  const backgroundColor = theme[sidebarPane ? "--color-drawer" : "--color-card"];
  const radius = sidebarPane ? 20 : inFolderCard ? 0 : 8;
  const style: ViewStyle = {
    backgroundColor: selected ? selectedBackgroundColor : backgroundColor,
    borderRadius: radius,
    ...(sidebarPane || inFolderCard
      ? {}
      : { borderWidth: 1, borderColor: theme["--color-border-subtle"] }),
  };
  const swipeContainerStyle: ViewStyle = inFolderCard
    ? { overflow: "hidden" }
    : {
        borderRadius: radius,
        overflow: "hidden",
        marginHorizontal: sidebarPane ? 8 : 12,
        marginVertical: sidebarPane ? 2 : 3,
      };

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
