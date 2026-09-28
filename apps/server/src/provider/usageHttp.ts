import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, type HttpClientRequest } from "effect/unstable/http";

export class UsageHttpError extends Schema.TaggedError<UsageHttpError>()("UsageHttpError", {
  kind: Schema.Literals(["authentication", "rateLimited", "network", "http"]),
  message: Schema.String,
  status: Schema.optional(Schema.Number),
}) {}

function retryAfterMillis(value: string | undefined, now: number): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Number.isFinite(seconds * 1_000) ? Math.max(0, seconds * 1_000) : 0;
  const date = DateTime.make(value);
  return Option.isSome(date) ? Math.max(0, DateTime.toEpochMillis(date.value) - now) : 0;
}

/** One reader per provider; cooldowns follow an account and endpoint, never another instance. */
export function makeUsageHttpReader() {
  const cooldowns = new Map<string, { until: number; attempts: number }>();
  return Effect.fnUntraced(function* (input: {
    readonly provider: string;
    readonly credential: string;
    readonly request: HttpClientRequest.HttpClientRequest;
    readonly authMessage?: string;
    readonly allowedStatuses?: ReadonlyArray<number>;
  }) {
    // Keep neither credentials nor account-specific query parameters in the cache.
    const keyHash = NodeCrypto.createHash("sha256")
      .update(input.request.url)
      .update("\0")
      .update(input.credential);
    for (const [name, value] of input.request.urlParams) {
      keyHash.update("\0").update(name).update("\0").update(value);
    }
    const key = keyHash.digest("hex");
    const now = yield* Clock.currentTimeMillis;
    const previous = cooldowns.get(key);
    const rateLimited = () =>
      new UsageHttpError({
        kind: "rateLimited",
        status: 429,
        message: `${input.provider} is limiting usage requests. ViewCode will retry automatically after the cooldown.`,
      });
    if (previous && previous.until > now) return yield* rateLimited();

    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(input.request).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError(
        () =>
          new UsageHttpError({
            kind: "network",
            message: `${input.provider} usage could not be reached. Check your connection and try again.`,
          }),
      ),
    );
    if (response.status === 429) {
      const receivedAt = yield* Clock.currentTimeMillis;
      const attempts = previous && previous.until > now - 60 * 60_000 ? previous.attempts : 0;
      const delay = Math.max(
        Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts, 4)),
        retryAfterMillis(response.headers["retry-after"], receivedAt),
      );
      // Bound retired-account entries without discarding another account's active cooldown.
      for (const [cachedKey, value] of cooldowns) {
        if (value.until < receivedAt - 60 * 60_000) cooldowns.delete(cachedKey);
      }
      cooldowns.set(key, { until: receivedAt + delay, attempts: attempts + 1 });
      return yield* rateLimited();
    }
    cooldowns.delete(key);
    if (input.allowedStatuses?.includes(response.status)) return response;
    if (response.status === 401 || response.status === 403) {
      return yield* new UsageHttpError({
        kind: "authentication",
        status: response.status,
        message:
          input.authMessage ??
          `${input.provider} rejected the saved sign-in. Sign in to ${input.provider} again, then refresh usage.`,
      });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new UsageHttpError({
        kind: "http",
        status: response.status,
        message: `${input.provider} usage is temporarily unavailable (HTTP ${response.status}). Try again later.`,
      });
    }
    return response;
  });
}
