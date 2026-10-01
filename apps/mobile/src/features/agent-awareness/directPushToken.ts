import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { Platform } from "react-native";

export type ExpoPushTokenResult =
  | { readonly ok: true; readonly token: string; readonly platform: "android" | "ios" }
  | { readonly ok: false; readonly reason: string };

let cached: Promise<ExpoPushTokenResult> | null = null;

function easProjectId(): string | undefined {
  const fromExtra = (Constants.expoConfig?.extra as { eas?: { projectId?: unknown } } | undefined)
    ?.eas?.projectId;
  if (typeof fromExtra === "string" && fromExtra.length > 0) return fromExtra;
  const fromEas = Constants.easConfig?.projectId;
  return typeof fromEas === "string" && fromEas.length > 0 ? fromEas : undefined;
}

/**
 * This phone's Expo push token, which the computers post notifications to.
 * It needs the build's EAS project and, on Android, its Firebase setup
 * (`google-services.json`); without either the reason says what is missing.
 * Read once per app launch; a failure is retried next time.
 */
export function readExpoPushToken(): Promise<ExpoPushTokenResult> {
  if (cached) return cached;
  const platform = Platform.OS;
  if (platform !== "android" && platform !== "ios") {
    return Promise.resolve({ ok: false, reason: "Notifications need the Android or iOS app." });
  }
  const projectId = easProjectId();
  if (!projectId) {
    return Promise.resolve({
      ok: false,
      reason: "This build has no EAS project, so it cannot receive notifications.",
    });
  }
  const attempt = Notifications.getExpoPushTokenAsync({ projectId }).then(
    (token): ExpoPushTokenResult => ({ ok: true, token: token.data, platform }),
    (): ExpoPushTokenResult => ({
      ok: false,
      reason:
        platform === "android"
          ? "This build was made without Firebase (google-services.json), so it cannot receive notifications."
          : "This device could not get a push token.",
    }),
  );
  cached = attempt;
  void attempt.then((result) => {
    if (!result.ok) cached = null;
  });
  return attempt;
}
