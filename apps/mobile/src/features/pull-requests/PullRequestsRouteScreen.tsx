import { useNavigation } from "@react-navigation/native";
import { useMemo } from "react";
import { Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import {
  WorkspaceTabsContext,
  WorkspaceTabsProvider,
  useWorkspaceTabs,
} from "../workspace/WorkspaceTabsContext";
import { PullRequestsScreen } from "./PullRequestsScreen";

/**
 * ViewCode's pull request list as its own screen. Android shows the list as a workspace tab;
 * iOS has no tab bar here (upstream's comes from react-native-screens 5), so Home opens this.
 */
export function PullRequestsRouteScreen() {
  return (
    <WorkspaceTabsProvider>
      <PullRequestsRouteContent />
    </WorkspaceTabsProvider>
  );
}

function PullRequestsRouteContent() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const workspace = useWorkspaceTabs()!;
  const { dispatch } = workspace;
  const context = useMemo(
    () => ({ ...workspace, bottomClearance: insets.bottom + 16 }),
    [workspace, insets.bottom],
  );
  return (
    <WorkspaceTabsContext value={context}>
      <View className="flex-1 bg-screen">
        <NativeStackScreenOptions
          options={{
            title: "Pull requests",
            headerShown: Platform.OS !== "android",
            headerSearchBarOptions: {
              autoCapitalize: "none",
              hideNavigationBar: false,
              placeholder: "Search pull requests",
              onFocus: () => dispatch({ type: "search", tab: "pullRequests" }),
              onChangeText: (event) =>
                dispatch({ type: "query", query: event.nativeEvent.text, tab: "pullRequests" }),
              onCancelButtonPress: () => dispatch({ type: "cancel", tab: "pullRequests" }),
            },
          }}
        />
        {Platform.OS === "android" ? (
          <AndroidScreenHeader title="Pull requests" onBack={() => navigation.goBack()} />
        ) : null}
        <PullRequestsScreen />
      </View>
    </WorkspaceTabsContext>
  );
}
