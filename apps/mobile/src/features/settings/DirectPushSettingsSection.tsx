import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { PushNotificationCategory } from "@t3tools/contracts";
import { settleAsyncResult } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useState } from "react";
import { Alert, Linking } from "react-native";

import {
  DIRECT_PUSH_CATEGORY_ORDER,
  resolveDirectPushPreferences,
  setDirectPushCategory,
} from "../agent-awareness/directPush";
import { readExpoPushToken } from "../agent-awareness/directPushToken";
import { requestAgentNotificationPermission } from "../agent-awareness/notificationPermissions";
import { runtime } from "../../lib/runtime";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import type { SymbolView } from "../../components/AppSymbol";
import type { ComponentProps } from "react";

const CATEGORY_ROWS: Record<
  PushNotificationCategory,
  { readonly label: string; readonly icon: ComponentProps<typeof SymbolView>["name"] }
> = {
  finished: { label: "Agent finished", icon: "checkmark.circle" },
  needsYou: { label: "Needs you", icon: "exclamationmark.circle" },
  usageLimit: { label: "Usage limit reached", icon: "exclamationmark.triangle" },
  resumed: { label: "Resumed after the limit", icon: "arrow.clockwise" },
};

/**
 * Notifications that each connected computer sends itself through Expo push,
 * with no T3 Connect account. Child agents' notifications carry their lead's
 * title.
 */
export function DirectPushSettingsSection() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  const preferences = resolveDirectPushPreferences(
    loaded ? preferencesResult.value.directPush : undefined,
  );

  const turnOn = async () => {
    setBusy(true);
    try {
      const permission = await settleAsyncResult(() =>
        runtime.runPromiseExit(requestAgentNotificationPermission),
      );
      if (permission._tag === "Failure" || permission.value.type !== "granted") {
        const canAskAgain =
          permission._tag === "Success" &&
          permission.value.type === "denied" &&
          permission.value.canAskAgain;
        Alert.alert(
          "Notifications are off for ViewCode",
          "Allow notifications for this app to get them from your computers.",
          canAskAgain
            ? [{ text: "OK" }]
            : [
                { text: "Cancel", style: "cancel" },
                { text: "Open Settings", onPress: () => void Linking.openSettings() },
              ],
        );
        return;
      }
      const token = await readExpoPushToken();
      if (!token.ok) {
        setProblem(token.reason);
        return;
      }
      setProblem(null);
      savePreferences({ directPush: { ...preferences, enabled: true } });
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsSection title="From your computers">
      <SettingsSwitchRow
        icon="bell.badge"
        label="Phone notifications"
        subtitle={
          problem ??
          "Each connected computer notifies this phone when an agent finishes or needs you."
        }
        disabled={!loaded || busy}
        value={preferences.enabled}
        onValueChange={(enabled) => {
          if (enabled) {
            void turnOn();
            return;
          }
          savePreferences({ directPush: { ...preferences, enabled: false } });
        }}
      />
      {DIRECT_PUSH_CATEGORY_ORDER.map((category) => (
        <SettingsSwitchRow
          key={category}
          icon={CATEGORY_ROWS[category].icon}
          label={CATEGORY_ROWS[category].label}
          disabled={!loaded || !preferences.enabled}
          value={preferences.categories[category]}
          onValueChange={(enabled) =>
            savePreferences({
              directPush: setDirectPushCategory(preferences, category, enabled),
            })
          }
        />
      ))}
    </SettingsSection>
  );
}
