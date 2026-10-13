import { Platform, View } from "react-native";

import { NativeStackScreenOptions } from "../../native/StackHeader";
import { PullRequestListProvider, usePullRequestListContext } from "./PullRequestListContext";
import { MaterialPullRequestToolbar } from "./MaterialPullRequestToolbar.android";
import { PullRequestsScreen } from "./PullRequestsScreen";

export function PullRequestsRouteScreen() {
  return (
    <PullRequestListProvider>
      <PullRequestsRouteContent />
    </PullRequestListProvider>
  );
}

function PullRequestsRouteContent() {
  const { dispatch, getScrollOffset, recordScrollOffset, state } = usePullRequestListContext();
  return (
    <View className="flex-1 bg-screen">
      <NativeStackScreenOptions
        options={{
          title: "Pull requests",
          headerShown: Platform.OS !== "android",
          headerSearchBarOptions: {
            autoCapitalize: "none",
            hideNavigationBar: false,
            placeholder: "Search pull requests",
            onFocus: () => {
              dispatch({ type: "scroll", offset: getScrollOffset() });
              dispatch({ type: "search" });
            },
            onChangeText: (event) => dispatch({ type: "query", query: event.nativeEvent.text }),
            onCancelButtonPress: () => {
              recordScrollOffset(state.searchEntryOffset);
              dispatch({ type: "cancel" });
            },
          },
        }}
      />
      {Platform.OS === "android" ? <MaterialPullRequestToolbar /> : null}
      <PullRequestsScreen />
    </View>
  );
}
