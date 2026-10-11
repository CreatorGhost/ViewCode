import { ScreenScrollView as ScrollView } from "../../components/ScreenScrollView";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { DirectPushSettingsSection } from "./DirectPushSettingsSection";
import { SettingsScreen } from "./components/SettingsScreen";

export function SettingsNotificationsRouteScreen() {
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Notifications">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <DirectPushSettingsSection />
        <Text className="px-1 text-sm text-foreground-muted">
          Tap a notification to open its thread.
        </Text>
      </ScrollView>
    </SettingsScreen>
  );
}
