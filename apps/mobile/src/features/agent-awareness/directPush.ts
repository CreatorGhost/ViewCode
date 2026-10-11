import type { PushNotificationCategories, PushNotificationCategory } from "@t3tools/contracts";

/**
 * Notifications sent by each connected computer through Expo's push service,
 * with no account or hosted relay. The phone keeps the switch and the categories; the
 * computer only sends what the phone registered for. Pure so the rules can be
 * tested without React Native.
 */
export interface DirectPushPreferences {
  readonly enabled: boolean;
  readonly categories: PushNotificationCategories;
}

export const DIRECT_PUSH_CATEGORY_ORDER: ReadonlyArray<PushNotificationCategory> = [
  "finished",
  "needsYou",
  "usageLimit",
  "resumed",
];

export const DEFAULT_DIRECT_PUSH_PREFERENCES: DirectPushPreferences = {
  enabled: false,
  categories: { finished: true, needsYou: true, usageLimit: true, resumed: true },
};

/** Stored preferences, tolerating older or hand-edited shapes: unknown means the default. */
export function resolveDirectPushPreferences(stored: unknown): DirectPushPreferences {
  if (typeof stored !== "object" || stored === null) return DEFAULT_DIRECT_PUSH_PREFERENCES;
  const record = stored as { readonly enabled?: unknown; readonly categories?: unknown };
  const categories =
    typeof record.categories === "object" && record.categories !== null
      ? (record.categories as Partial<Record<PushNotificationCategory, unknown>>)
      : {};
  const flag = (category: PushNotificationCategory) =>
    typeof categories[category] === "boolean"
      ? (categories[category] as boolean)
      : DEFAULT_DIRECT_PUSH_PREFERENCES.categories[category];
  return {
    enabled: record.enabled === true,
    categories: {
      finished: flag("finished"),
      needsYou: flag("needsYou"),
      usageLimit: flag("usageLimit"),
      resumed: flag("resumed"),
    },
  };
}

export function setDirectPushCategory(
  preferences: DirectPushPreferences,
  category: PushNotificationCategory,
  enabled: boolean,
): DirectPushPreferences {
  return { ...preferences, categories: { ...preferences.categories, [category]: enabled } };
}

/** Turning every category off is the same as turning notifications off. */
export function directPushWantsAnything(preferences: DirectPushPreferences): boolean {
  return (
    preferences.enabled &&
    DIRECT_PUSH_CATEGORY_ORDER.some((category) => preferences.categories[category])
  );
}

/** What was last registered with a computer, to skip repeating it. */
export function directPushRegistrationKey(
  token: string,
  categories: PushNotificationCategories,
): string {
  return [
    token,
    ...DIRECT_PUSH_CATEGORY_ORDER.map((category) => (categories[category] ? 1 : 0)),
  ].join("|");
}

/**
 * Which connected computers need a registration and which an unregistration.
 * `desired` is null when notifications are off (or impossible on this device);
 * `synced` holds what each computer was last told this app session (null:
 * told to forget this phone). With notifications off, a computer not yet told
 * anything this session is told to forget the phone only if the user ever
 * turned them on (`everEnabled`), so phones that never used them send nothing.
 */
export function planDirectPushSync<Id extends string>(input: {
  readonly desired: { readonly key: string } | null;
  readonly everEnabled: boolean;
  readonly connected: ReadonlyArray<Id>;
  readonly synced: ReadonlyMap<Id, string | null>;
}): { readonly register: ReadonlyArray<Id>; readonly unregister: ReadonlyArray<Id> } {
  const register: Id[] = [];
  const unregister: Id[] = [];
  for (const id of input.connected) {
    const last = input.synced.get(id);
    if (input.desired === null) {
      if (last === null) continue;
      if (last !== undefined || input.everEnabled) unregister.push(id);
    } else if (last !== input.desired.key) {
      register.push(id);
    }
  }
  return { register, unregister };
}
