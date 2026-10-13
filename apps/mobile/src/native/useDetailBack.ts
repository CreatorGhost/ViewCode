import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback } from "react";
import { BackHandler, Keyboard, Platform } from "react-native";

/** Keep nested chat and PR history; cold links return to their list. */
export function useDetailBack(fallback: "Home" | "PullRequests") {
  const navigation = useNavigation();
  const goBack = useCallback(() => {
    if (navigation.canGoBack()) navigation.goBack();
    else navigation.dispatch(StackActions.replace(fallback));
  }, [navigation, fallback]);
  useFocusEffect(
    useCallback(() => {
      if (Platform.OS !== "android") return;
      const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
        if (Keyboard.isVisible()) Keyboard.dismiss();
        else goBack();
        return true;
      });
      return () => subscription.remove();
    }, [goBack]),
  );
  return goBack;
}
