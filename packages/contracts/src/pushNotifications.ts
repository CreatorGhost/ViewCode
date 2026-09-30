import * as Schema from "effect/Schema";

/**
 * ViewCode phone notifications sent straight from the environment through the
 * Expo push service, without T3 Connect. The phone registers its Expo push
 * token over its own authenticated connection; the environment keeps it for
 * that client session and forgets it when the session is revoked or expires.
 */

/** What a notification is about. The phone can turn each off. */
export const PushNotificationCategories = Schema.Struct({
  /** A turn finished (or failed for a reason other than a usage limit). */
  finished: Schema.Boolean,
  /** The agent is waiting on an approval or a question. */
  needsYou: Schema.Boolean,
  /** A provider's usage limit stopped the agent. */
  usageLimit: Schema.Boolean,
  /** Work continued by itself after the limit reset. */
  resumed: Schema.Boolean,
});
export type PushNotificationCategories = typeof PushNotificationCategories.Type;

export type PushNotificationCategory = keyof PushNotificationCategories;

/** Expo's own token shape; anything else is refused so the server never posts arbitrary strings. */
export const ExpoPushToken = Schema.String.check(
  Schema.isPattern(/^Expo(?:nent)?PushToken\[[A-Za-z0-9_-]{8,200}\]$/),
);
export type ExpoPushToken = typeof ExpoPushToken.Type;

export const PushRegisterInput = Schema.Struct({
  token: ExpoPushToken,
  platform: Schema.Literals(["android", "ios"]),
  categories: PushNotificationCategories,
});
export type PushRegisterInput = typeof PushRegisterInput.Type;

export const PushUnregisterInput = Schema.Struct({});
export type PushUnregisterInput = typeof PushUnregisterInput.Type;

export const PushRegistrationResult = Schema.Struct({
  /** False when unregistering found nothing for this client. */
  changed: Schema.Boolean,
});
export type PushRegistrationResult = typeof PushRegistrationResult.Type;

export class PushNotificationError extends Schema.TaggedError<PushNotificationError>()(
  "PushNotificationError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}
