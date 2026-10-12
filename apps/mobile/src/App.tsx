import * as Linking from "expo-linking";
import * as SplashScreen from "expo-splash-screen";
import { useCallback, useEffect } from "react";
import { StatusBar } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { createStaticNavigation, useNavigationContainerRef } from "@react-navigation/native";

import { RegistryContext } from "@effect/atom-react";
import { ThreadArrangementHost } from "./features/threads/ThreadArrangementSheet";
import { ConfirmDialogHost } from "./components/ConfirmDialogHost";
import { prepareNativeShowcaseCapture } from "./features/showcase/nativeShowcaseScene";
import { IncomingShareProvider } from "./features/sharing/IncomingShareProvider";
import {
  AppearancePreferencesProvider,
  useAppearancePreferences,
} from "./features/settings/appearance/AppearancePreferencesProvider";
import { RootStack } from "./Stack";
import { appAtomRegistry } from "./state/atom-registry";
import { OverlayPortalHost } from "./components/OverlayPortal";
import { shouldHandleAppLink } from "./lib/appLinking";
import { useMobileNavigationTheme } from "./lib/useMobileNavigationTheme";
import { useUiRuntimeMemoryWarningGc } from "./lib/useUiRuntimeMemoryWarningGc";
import { SubscriptionUsageCoordinator } from "./widgets/SubscriptionUsageCoordinator";
import { VoiceInputProvider } from "./features/voice-input/VoiceInputProvider";
import { GlobalVoiceInputControl } from "./features/voice-input/GlobalVoiceInputControl";
import {
  resolveVoiceInputThreadReturn,
  type VoiceInputThread,
} from "./features/voice-input/voiceInputReturn";

import "../global.css";

if (process.env.EXPO_PUBLIC_SHOWCASE === "1") {
  prepareNativeShowcaseCapture();
}

void SplashScreen.preventAutoHideAsync().catch(() => {
  // The native module can be unavailable in non-native test environments.
});

const appLinking = {
  // ViewCode registers only its own schemes; the t3code ones stay so links
  // built with the stock scheme (widgets target this package explicitly)
  // still route.
  prefixes: [
    Linking.createURL("/"),
    "viewcode://",
    "viewcode-dev://",
    "viewcode-preview://",
    "t3code://",
    "t3code-dev://",
    "t3code-preview://",
  ],
  // Keep the compact thread list available beneath a directly opened thread.
  config: { initialRouteName: "Home" },
  filter: shouldHandleAppLink,
};

const Navigation = createStaticNavigation(RootStack);

function SplashScreenCoordinator() {
  const { isReady } = useAppearancePreferences();

  useEffect(() => {
    if (isReady) void SplashScreen.hide();
  }, [isReady]);

  return null;
}

export default function App() {
  useUiRuntimeMemoryWarningGc();

  return (
    <RegistryContext.Provider value={appAtomRegistry}>
      <AppearancePreferencesProvider>
        <AppContent />
      </AppearancePreferencesProvider>
    </RegistryContext.Provider>
  );
}

function AppContent() {
  const { themeAppearance } = useAppearancePreferences();
  const navigationTheme = useMobileNavigationTheme();
  const navigationRef = useNavigationContainerRef();
  const openDictationThread = useCallback(
    (thread: VoiceInputThread) => {
      if (!navigationRef.isReady()) return;
      const action = resolveVoiceInputThreadReturn(navigationRef.getRootState(), thread);
      if (action) navigationRef.dispatch(action);
    },
    [navigationRef],
  );

  return (
    <>
      <SplashScreenCoordinator />
      <SubscriptionUsageCoordinator />
      <GestureHandlerRootView className="flex-1">
        <KeyboardProvider statusBarTranslucent>
          <SafeAreaProvider>
            <VoiceInputProvider>
              <StatusBar barStyle={themeAppearance === "dark" ? "light-content" : "dark-content"} />
              {/* The navigation theme drives the NATIVE header appearance: native-stack
                forwards `dark` as the nav bar's overrideUserInterfaceStyle. Without
                this, React Navigation defaults to its light theme and every native
                header (glass buttons, title, materials) is forced light even when
                the system is in dark mode. */}
              <GlobalVoiceInputControl onOpenThread={openDictationThread}>
                <IncomingShareProvider>
                  <Navigation ref={navigationRef} linking={appLinking} theme={navigationTheme} />
                </IncomingShareProvider>
                <ConfirmDialogHost />
                <ThreadArrangementHost />
              </GlobalVoiceInputControl>
              {/* Anchored-menu overlays render here — in-window, so the
                keyboard stays up while a dropdown is open. */}
              <OverlayPortalHost />
            </VoiceInputProvider>
          </SafeAreaProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </>
  );
}
