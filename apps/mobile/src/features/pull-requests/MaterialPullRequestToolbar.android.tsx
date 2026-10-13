import { useIsFocused, useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useRef } from "react";
import { BackHandler, Keyboard, type TextInputInstance } from "react-native";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { MaterialSearchField } from "../../components/MaterialSearchField";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { usePullRequestListContext } from "./PullRequestListContext";
import { useDetailBack } from "../../native/useDetailBack";

/** PR search shares the thread list's native Android header placement. */
export function MaterialPullRequestToolbar() {
  const navigation = useNavigation();
  const goBack = useDetailBack("Home");
  const {
    dispatch,
    getScrollOffset,
    recordScrollOffset,
    state: search,
  } = usePullRequestListContext();
  const listFocused = useIsFocused();
  const input = useRef<TextInputInstance>(null);
  const searching = search.searching;
  const openSearch = useCallback(() => {
    dispatch({
      type: "scroll",
      offset: getScrollOffset(),
    });
    dispatch({ type: "search" });
    input.current?.focus();
    return true;
  }, [dispatch, getScrollOffset]);
  useHardwareKeyboardCommand("focusSearch", openSearch);
  const closeSearch = useCallback(() => {
    Keyboard.dismiss();
    recordScrollOffset(search.searchEntryOffset);
    dispatch({ type: "cancel" });
  }, [dispatch, recordScrollOffset, search.searchEntryOffset]);
  useEffect(() => {
    if (!searching || !listFocused) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // A covered list may retain its search effect while a detail owns Back.
      const state = navigation.getState();
      if (!state || state.routes[state.index]?.name !== "PullRequests") return false;
      if (Keyboard.isVisible()) Keyboard.dismiss();
      else closeSearch();
      return true;
    });
    return () => subscription.remove();
  }, [searching, closeSearch, listFocused, navigation]);
  return (
    <AndroidScreenHeader
      title="Pull requests"
      titleContent={
        searching ? (
          <MaterialSearchField
            inputRef={input}
            accessibilityLabel="Search pull requests"
            clearAccessibilityLabel="Clear search"
            placeholder="Search pull requests"
            value={search.query}
            onChangeText={(query) => dispatch({ type: "query", query })}
          />
        ) : undefined
      }
      onBack={searching ? closeSearch : goBack}
      actions={
        searching
          ? []
          : [
              {
                accessibilityLabel: "Search pull requests",
                icon: "magnifyingglass",
                onPress: openSearch,
              },
              {
                accessibilityLabel: "Open settings",
                icon: "gearshape",
                onPress: () =>
                  navigation.navigate("SettingsSheet", {
                    screen: "SettingsContent",
                    params: { screen: "Settings" },
                  }),
              },
            ]
      }
    />
  );
}
