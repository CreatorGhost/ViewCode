import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Notifications from "expo-notifications";
import { AsyncResult } from "effect/unstable/reactivity";
import { useEffect, useEffectEvent, useRef } from "react";

import { mobilePreferencesAtom } from "../../state/preferences";
import { environmentPresentations } from "../../state/presentation";
import { pushEnvironment } from "../../state/pushNotifications";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  directPushRegistrationKey,
  directPushWantsAnything,
  planDirectPushSync,
  resolveDirectPushPreferences,
} from "./directPush";
import { readExpoPushToken } from "./directPushToken";

/**
 * Keeps every connected computer's copy of this phone's push registration in
 * step with Settings → Notifications: registers on connect and when the
 * categories change, and tells computers to forget the phone when
 * notifications are turned off or permission is withdrawn. Runs only on
 * connection and preference changes; nothing polls.
 */
export function useDirectPushRegistration(): void {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const presentations = useAtomValue(environmentPresentations.presentationsAtom);
  const register = useAtomCommand(pushEnvironment.register, { reportFailure: false });
  const unregister = useAtomCommand(pushEnvironment.unregister, { reportFailure: false });
  // What each computer was last told this app session; a reconnect tells it again.
  const synced = useRef(new Map<EnvironmentId, string | null>());

  const loaded = AsyncResult.isSuccess(preferencesResult);
  const stored = loaded ? preferencesResult.value.directPush : undefined;
  const preferences = resolveDirectPushPreferences(stored);
  const everEnabled = stored !== undefined;
  const connected = [...presentations]
    .filter(([, presentation]) => presentation.connection.phase === "connected")
    .map(([environmentId]) => environmentId)
    .sort();
  const connectedKey = connected.join("\n");
  const preferencesKey = JSON.stringify([preferences, everEnabled]);

  const sync = useEffectEvent(async () => {
    for (const id of synced.current.keys()) {
      if (!connected.includes(id)) synced.current.delete(id);
    }
    if (connected.length === 0) return;
    let desired: { key: string; token: string; platform: "android" | "ios" } | null = null;
    if (directPushWantsAnything(preferences)) {
      const permission = await Notifications.getPermissionsAsync().catch(() => null);
      const token = permission?.granted ? await readExpoPushToken() : null;
      if (token?.ok) {
        desired = {
          key: directPushRegistrationKey(token.token, preferences.categories),
          token: token.token,
          platform: token.platform,
        };
      }
    }
    const plan = planDirectPushSync({ desired, everEnabled, connected, synced: synced.current });
    for (const environmentId of plan.register) {
      if (!desired) break;
      const result = await register({
        environmentId,
        input: {
          token: desired.token,
          platform: desired.platform,
          categories: preferences.categories,
        },
      });
      if (result._tag === "Success") synced.current.set(environmentId, desired.key);
    }
    for (const environmentId of plan.unregister) {
      const result = await unregister({ environmentId, input: {} });
      if (result._tag === "Success") synced.current.set(environmentId, null);
    }
  });

  useEffect(() => {
    if (loaded) void sync();
  }, [loaded, connectedKey, preferencesKey]);
}
