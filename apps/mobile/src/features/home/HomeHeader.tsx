import { NativeHeaderToolbar, NativeStackScreenOptions } from "../../native/StackHeader";
import { useCallback, useRef } from "react";
import type { SearchBarCommands } from "react-native-screens";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { withNativeGlassHeaderItem } from "../layout/native-glass-header-items";
import {
  createNativeMailSearchToolbarItem,
  NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED,
} from "../layout/native-mail-search-toolbar";
import { HomeFleetTitle } from "./HomePillToolbar";
import { buildHomeListFilterMenu } from "./home-list-filter-menu";
import { HOME_TERMINAL_MENU_LIMIT, homeTerminalButtonAccessibility } from "./homeTerminalTargets";
import type { HomeHeaderProps } from "./HomeHeader.types";

export type { HomeHeaderEnvironment } from "./HomeHeader.types";

export function HomeHeader(props: HomeHeaderProps) {
  const searchBarRef = useRef<SearchBarCommands>(null);
  const iconColor = useUniwindTheme()["--color-icon"];
  // The list uses a fixed creation order and ignores sort/group options, so
  // the filter menu only carries the filters and the "customized" icon state
  // keys off those alone.
  const hasCustomListOptions =
    props.selectedEnvironmentId !== null || props.selectedProjectKey !== null;
  const focusSearch = useCallback(() => {
    searchBarRef.current?.focus();
    return searchBarRef.current !== null;
  }, []);
  useHardwareKeyboardCommand("focusSearch", focusSearch);
  const filterMenu = buildHomeListFilterMenu(props);
  const { onOpenTerminal, selectedTerminalTarget, terminalTargets } = props;
  const terminalMenuTargets = terminalTargets.slice(0, HOME_TERMINAL_MENU_LIMIT);
  const terminalAccessibility = homeTerminalButtonAccessibility(
    terminalTargets,
    selectedTerminalTarget,
  );
  // Terminals belong to a thread: a selected project opens its latest one, else a menu picks it.
  const terminalItem = withNativeGlassHeaderItem(
    selectedTerminalTarget || terminalMenuTargets.length === 0
      ? {
          accessibilityLabel: terminalAccessibility.label,
          accessibilityHint: terminalAccessibility.hint,
          disabled: terminalMenuTargets.length === 0,
          icon: { name: "apple.terminal", type: "sfSymbol" } as const,
          identifier: "home-terminal",
          label: "",
          onPress: () => {
            if (selectedTerminalTarget) onOpenTerminal(selectedTerminalTarget);
          },
          type: "button" as const,
        }
      : {
          accessibilityLabel: terminalAccessibility.label,
          accessibilityHint: terminalAccessibility.hint,
          icon: { name: "apple.terminal", type: "sfSymbol" } as const,
          identifier: "home-terminal",
          label: "",
          menu: {
            title: "Open terminal in…",
            items: terminalMenuTargets.map((target) => ({
              type: "action" as const,
              label: target.projectTitle,
              description: target.threadTitle,
              onPress: () => onOpenTerminal(target),
            })),
          },
          type: "menu" as const,
        },
  );
  const renderTitle = useCallback(
    () => <HomeFleetTitle onOpenEnvironments={props.onOpenEnvironments} />,
    [props.onOpenEnvironments],
  );

  return (
    <>
      <NativeStackScreenOptions
        optionsVersion={[
          filterMenu.items,
          selectedTerminalTarget?.scopeKey ?? null,
          terminalMenuTargets.map((target) => [target.scopeKey, target.threadId]),
        ]}
        options={{
          // Keep UIKit's glass and scroll-edge behavior with a centered fleet title.
          headerShown: true,
          headerTitleAlign: "center",
          unstable_navigationItemStyle: undefined,
          headerTitle: renderTitle,
          headerTintColor: iconColor,
          unstable_headerLeftItems: () => [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Open settings",
              icon: { name: "gearshape", type: "sfSymbol" } as const,
              identifier: "home-settings",
              label: "",
              onPress: props.onOpenSettings,
              type: "button",
            }),
            // Beside Settings, so each side holds a two-button capsule and the brand title stays centred.
            terminalItem,
          ],
          unstable_headerRightItems: () => [
            withNativeGlassHeaderItem({
              accessibilityLabel: "Open usage",
              icon: { name: "chart.bar.xaxis", type: "sfSymbol" } as const,
              identifier: "home-usage",
              label: "",
              onPress: props.onOpenUsage,
              type: "button",
            }),
          ],
          // The keys below are set per-branch (not `undefined`) so a later
          // reapply cannot clobber options owned by NativeHeaderToolbar.
          ...(NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED
            ? {
                unstable_headerToolbarItems: () => [
                  createNativeMailSearchToolbarItem({
                    composeButtonId: "home-new-task",
                    composeSystemImageName: "square.and.pencil",
                    filterMenu,
                    filterButtonId: "home-filter",
                    filterSystemImageName: hasCustomListOptions
                      ? "line.3.horizontal.decrease.circle.fill"
                      : "line.3.horizontal.decrease",
                    onComposePress: props.onStartNewTask,
                    onSearchTextChange: props.onSearchQueryChange,
                    placeholder: "Search",
                    searchTextChangeId: "home-search-text",
                    showsSearchDismissButton: true,
                  }),
                ],
              }
            : {
                // Pre-Liquid-Glass iOS: standard pull-down search in the nav
                // bar; create + sort live in the plain bottom toolbar below.
                headerSearchBarOptions: {
                  ref: searchBarRef,
                  autoCapitalize: "none" as const,
                  hideNavigationBar: false,
                  placeholder: "Search",
                  onCancelButtonPress: () => {
                    props.onSearchQueryChange("");
                  },
                  onChangeText: (event) => {
                    props.onSearchQueryChange(event.nativeEvent.text);
                  },
                },
              }),
        }}
      />

      {NATIVE_MAIL_SEARCH_TOOLBAR_SUPPORTED ? null : (
        <NativeHeaderToolbar placement="bottom">
          <NativeHeaderToolbar.Menu
            accessibilityLabel="Filter threads"
            icon={
              hasCustomListOptions
                ? "line.3.horizontal.decrease.circle.fill"
                : "line.3.horizontal.decrease.circle"
            }
            title="Thread list options"
            separateBackground
          >
            <NativeHeaderToolbar.Menu title="Environment">
              <NativeHeaderToolbar.Label>Environment</NativeHeaderToolbar.Label>
              <NativeHeaderToolbar.MenuAction
                isOn={props.selectedEnvironmentId === null}
                onPress={() => props.onEnvironmentChange(null)}
                subtitle="Show threads from every environment"
              >
                <NativeHeaderToolbar.Label>All environments</NativeHeaderToolbar.Label>
              </NativeHeaderToolbar.MenuAction>
              {props.environments.map((environment) => (
                <NativeHeaderToolbar.MenuAction
                  key={environment.environmentId}
                  isOn={props.selectedEnvironmentId === environment.environmentId}
                  onPress={() => props.onEnvironmentChange(environment.environmentId)}
                >
                  <NativeHeaderToolbar.Label>{environment.label}</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
              ))}
            </NativeHeaderToolbar.Menu>

            {props.projects.length > 0 ? (
              <NativeHeaderToolbar.Menu title="Project">
                <NativeHeaderToolbar.Label>Project</NativeHeaderToolbar.Label>
                <NativeHeaderToolbar.MenuAction
                  isOn={props.selectedProjectKey === null}
                  onPress={() => props.onProjectChange(null)}
                  subtitle="Show threads from every project"
                >
                  <NativeHeaderToolbar.Label>All projects</NativeHeaderToolbar.Label>
                </NativeHeaderToolbar.MenuAction>
                {props.projects.map((project) => (
                  <NativeHeaderToolbar.MenuAction
                    key={project.key}
                    isOn={props.selectedProjectKey === project.key}
                    onPress={() => props.onProjectChange(project.key)}
                  >
                    <NativeHeaderToolbar.Label>{project.label}</NativeHeaderToolbar.Label>
                  </NativeHeaderToolbar.MenuAction>
                ))}
              </NativeHeaderToolbar.Menu>
            ) : null}
          </NativeHeaderToolbar.Menu>
          <NativeHeaderToolbar.Spacer flexible />
          <NativeHeaderToolbar.Button
            accessibilityLabel="New task"
            icon="square.and.pencil"
            onPress={props.onStartNewTask}
            separateBackground
          />
        </NativeHeaderToolbar>
      )}
    </>
  );
}
