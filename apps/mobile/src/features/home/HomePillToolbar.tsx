import type { MenuAction } from "@react-native-menu/menu";
import { useCallback, useEffect, useRef, useState, type ComponentProps } from "react";
import { BackHandler, Keyboard, Pressable, type TextInput, View } from "react-native";

import { AndroidAnchoredMenu } from "../../components/AndroidAnchoredMenu";
import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import type { ControlPillMenu } from "../../components/ControlPill";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { useMaterialToolbarLayout } from "../../components/useMaterialToolbarLayout";
import { useWorkspaceState } from "../../state/workspace";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { HomePillIconButton, HomePillSurface } from "./HomePillButton";
import { WorkspaceConnectionTitle } from "./WorkspaceConnectionTitle";

type MenuActionHandler = NonNullable<ComponentProps<typeof ControlPillMenu>["onPressAction"]>;

/**
 * Android Home's top bar: settings, the environment pill (the connection
 * status takes its place while an environment is unreachable), usage and
 * search, with the project filter on the row below.
 */
export function HomePillToolbar(props: {
  readonly searchQuery: string;
  readonly onSearchQueryChange: (query: string) => void;
  readonly environmentLabel: string;
  readonly environmentActions: MenuAction[];
  readonly projectLabel: string;
  readonly projectActions: MenuAction[];
  readonly onMenuAction: MenuActionHandler;
  readonly onOpenSettings: () => void;
  readonly onOpenEnvironments: () => void;
  readonly onOpenUsage: () => void;
}) {
  const { paddingTop } = useMaterialToolbarLayout();
  const { scale, buttonSize } = useAndroidControlSizing();
  const { state } = useWorkspaceState();
  const { onSearchQueryChange } = props;
  const searchRef = useRef<TextInput>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const searching = searchOpen || props.searchQuery.length > 0;
  const openSearch = useCallback(() => {
    setSearchOpen(true);
    searchRef.current?.focus();
    return true;
  }, []);
  useHardwareKeyboardCommand("focusSearch", openSearch);

  const closeSearch = useCallback(() => {
    onSearchQueryChange("");
    setSearchOpen(false);
    Keyboard.dismiss();
  }, [onSearchQueryChange]);

  useEffect(() => {
    if (!searching) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [closeSearch, searching]);

  const environmentPill = (open?: () => void) => (
    <HomePillSurface
      accessibilityLabel={`Environment: ${props.environmentLabel}`}
      accessibilityHint="Chooses which environment's threads to show."
      onPress={open ?? props.onOpenEnvironments}
      className="min-w-0 flex-1"
      style={{ paddingHorizontal: 14 * scale, gap: 8 * scale }}
    >
      <WorkspaceConnectionTitle
        onPress={props.onOpenEnvironments}
        brand={
          <View className="min-w-0 flex-row items-center" style={{ gap: 8 * scale }}>
            <View className="size-2 rounded-full bg-adaptive-emerald-600-400" />
            <Text
              className="shrink font-t3-bold text-foreground"
              style={{ fontSize: 16 * scale }}
              numberOfLines={1}
            >
              {props.environmentLabel}
            </Text>
            <SymbolView
              name="chevron.down"
              size={Math.round(15 * scale)}
              tintColorClassName="accent-foreground-muted"
              type="monochrome"
            />
          </View>
        }
      />
    </HomePillSurface>
  );

  return (
    <View className="bg-screen" style={{ paddingTop }}>
      <View
        className="flex-row items-center"
        style={{ gap: 8 * scale, paddingHorizontal: 16, paddingVertical: 8 * scale }}
      >
        {searching ? (
          <>
            <HomePillIconButton
              accessibilityLabel="Close search"
              icon="arrow.left"
              onPress={closeSearch}
            />
            <MaterialSearchField
              inputRef={searchRef}
              accessibilityLabel="Search threads"
              clearAccessibilityLabel="Clear search"
              placeholder="Search threads"
              value={props.searchQuery}
              onChangeText={onSearchQueryChange}
            />
          </>
        ) : (
          <>
            <HomePillIconButton
              accessibilityLabel="Open settings"
              icon="gearshape"
              onPress={props.onOpenSettings}
            />
            {state.hasConnections ? (
              <AndroidAnchoredMenu
                actions={props.environmentActions}
                onPressAction={props.onMenuAction}
                className="min-w-0 flex-1"
              >
                {(open) => environmentPill(open)}
              </AndroidAnchoredMenu>
            ) : (
              environmentPill()
            )}
            <HomePillIconButton
              accessibilityLabel="Open usage"
              icon="chart.bar.xaxis"
              onPress={props.onOpenUsage}
            />
            <HomePillIconButton
              accessibilityLabel="Search threads"
              icon="magnifyingglass"
              onPress={openSearch}
            />
          </>
        )}
      </View>
      {!searching && props.projectActions.length > 1 ? (
        <View className="flex-row px-6">
          <AndroidAnchoredMenu actions={props.projectActions} onPressAction={props.onMenuAction}>
            {(open) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Project: ${props.projectLabel}`}
                accessibilityHint="Chooses which project's threads to show."
                onPress={open}
                hitSlop={{ top: 4, bottom: 4 }}
                className="flex-row items-center gap-1"
                style={({ pressed }) => ({ minHeight: buttonSize - 8, opacity: pressed ? 0.6 : 1 })}
              >
                <Text
                  className="text-foreground-muted"
                  style={{ fontSize: 16 * scale }}
                  numberOfLines={1}
                >
                  {props.projectLabel}
                </Text>
                <SymbolView
                  name="chevron.down"
                  size={Math.round(15 * scale)}
                  tintColorClassName="accent-foreground-muted"
                  type="monochrome"
                />
              </Pressable>
            )}
          </AndroidAnchoredMenu>
        </View>
      ) : null}
    </View>
  );
}
