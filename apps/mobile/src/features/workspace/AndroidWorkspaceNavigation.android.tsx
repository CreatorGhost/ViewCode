import { CommonActions, useNavigation } from "@react-navigation/native";
import { androidWorkspaceNavigationState } from "../../lib/android-workspace-navigation";
import { Keyboard, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useKeyboardState } from "react-native-keyboard-controller";

import { SymbolView, type AppSymbolName } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useAndroidControlSizing } from "../../components/useAndroidControlSizing";
import { androidWorkspaceNavigationColors } from "./android-workspace-navigation-colors";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { useWorkspaceTabs } from "./WorkspaceTabsContext";
import type { WorkspaceTab } from "./workspace-tabs-state";

export const ANDROID_WORKSPACE_RAIL_WIDTH = 80;

const TABS: ReadonlyArray<{
  readonly tab: WorkspaceTab;
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly railLabel: string;
}> = [
  { tab: "threads", icon: "text.bubble", label: "Chats", railLabel: "Chats" },
  { tab: "pullRequests", icon: "arrow.triangle.pull", label: "Pull requests", railLabel: "PRs" },
];

/**
 * Material 3 navigation bar on phones and navigation rail beside the split sidebar.
 *
 * Upstream draws these with a Compose module (T3WorkspaceNavigationModule). ViewCode draws the
 * same Material 3 geometry in React Native so the tab needs no new native code: an 80dp bar or
 * rail, a pill indicator behind the selected icon, and a 12sp label under each icon.
 */
export function AndroidWorkspaceNavigation(props: {
  readonly rail?: boolean;
  readonly onSelect?: () => void;
}) {
  const workspace = useWorkspaceTabs()!;
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const keyboardVisible = useKeyboardState((state) => state.isVisible);
  const { themeVariables: colors } = useAppearancePreferences();
  const { scale } = useAndroidControlSizing();
  const rail = Boolean(props.rail);
  const size = Math.max(1, scale);
  const { containerColor, indicatorColor, selectedColor, unselectedColor } =
    androidWorkspaceNavigationColors(colors, rail);
  if (!rail && keyboardVisible) return null;

  const select = (tab: WorkspaceTab) => {
    Keyboard.dismiss();
    if (tab !== workspace.state.selectedTab) {
      workspace.dispatch({ type: "select", tab });
      navigation.dispatch((state) => CommonActions.reset(androidWorkspaceNavigationState(state)));
    }
    props.onSelect?.();
  };

  return (
    <View
      accessibilityRole="tablist"
      style={{
        backgroundColor: containerColor,
        ...(rail
          ? {
              flex: 1,
              width: ANDROID_WORKSPACE_RAIL_WIDTH * size,
              paddingTop: insets.top,
              paddingBottom: insets.bottom,
              justifyContent: "center",
              gap: 12 * size,
            }
          : {
              flexDirection: "row",
              height: 80 * size + insets.bottom,
              paddingBottom: insets.bottom,
            }),
      }}
    >
      {TABS.map((item) => {
        const selected = workspace.state.selectedTab === item.tab;
        const tint = selected ? selectedColor : unselectedColor;
        return (
          <Pressable
            key={item.tab}
            accessibilityRole="tab"
            accessibilityLabel={item.label}
            accessibilityState={{ selected }}
            onPress={() => select(item.tab)}
            style={{
              alignItems: "center",
              justifyContent: "center",
              gap: 4 * size,
              ...(rail ? { paddingVertical: 4 * size } : { flex: 1, paddingTop: 4 * size }),
            }}
          >
            <View
              style={{
                width: (rail ? 56 : 64) * size,
                height: 32 * size,
                borderRadius: 16 * size,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: selected ? indicatorColor : "transparent",
              }}
            >
              <SymbolView name={item.icon} size={24 * size} tintColor={tint} />
            </View>
            <Text
              numberOfLines={1}
              allowFontScaling={false}
              className={selected ? "font-t3-bold" : "font-t3-medium"}
              style={{ color: tint, fontSize: 12 * size, lineHeight: 16 * size }}
            >
              {rail ? item.railLabel : item.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
