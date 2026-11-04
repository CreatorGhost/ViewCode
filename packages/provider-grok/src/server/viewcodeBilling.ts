// @effect-diagnostics nodeBuiltinImport:off - hash account credentials without retaining them in cooldown keys.
import * as NodeCrypto from "node:crypto";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

class ViewCodeGrokBillingError extends Schema.TaggedError<ViewCodeGrokBillingError>()(
  "ViewCodeGrokBillingError",
  {
    kind: Schema.Literals(["authentication", "rateLimited", "network", "http"]),
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.kind) {
      case "authentication":
        return "Grok rejected the saved sign-in. Sign in to Grok again, then refresh usage.";
      case "rateLimited":
        return "Grok is limiting usage requests. ViewCode will retry automatically after the cooldown.";
      case "network":
        return "Grok usage could not be reached. Check your connection and try again.";
      case "http":
        return `Grok usage is temporarily unavailable (HTTP ${this.status}). Try again later.`;
    }
  }
}

function retryAfterMillis(value: string | undefined, now: number): number {
  if (!value?.trim()) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds))
    return Number.isFinite(seconds * 1_000) ? Math.max(0, seconds * 1_000) : 0;
  const date = DateTime.make(value);
  return Option.isSome(date) ? Math.max(0, DateTime.toEpochMillis(date.value) - now) : 0;
}

/** Billing limits and cooldowns belong to the selected account, never another instance. */
export function makeViewCodeGrokBillingReader() {
  const cooldowns = new Map<string, { until: number; attempts: number }>();
  return Effect.fnUntraced(function* (credential: string) {
    const key = NodeCrypto.createHash("sha256")
      .update(BILLING_URL)
      .update("\0")
      .update(credential)
      .digest("hex");
    const now = yield* Clock.currentTimeMillis;
    const previous = cooldowns.get(key);
    if (previous && previous.until > now)
      return yield* new ViewCodeGrokBillingError({ kind: "rateLimited", status: 429 });

    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(
        HttpClientRequest.get(BILLING_URL).pipe(
          HttpClientRequest.bearerToken(credential),
          HttpClientRequest.setHeader("x-xai-token-auth", "xai-grok-cli"),
          HttpClientRequest.setHeader("Accept", "application/json"),
        ),
      )
      .pipe(
        Effect.timeout("10 seconds"),
        Effect.mapError((cause) => new ViewCodeGrokBillingError({ kind: "network", cause })),
      );
    if (response.status === 429) {
      const receivedAt = yield* Clock.currentTimeMillis;
      const attempts = previous && previous.until > now - 60 * 60_000 ? previous.attempts : 0;
      const delay = Math.max(
        Math.min(15 * 60_000, 60_000 * 2 ** Math.min(attempts, 4)),
        retryAfterMillis(response.headers["retry-after"], receivedAt),
      );
      for (const [cachedKey, value] of cooldowns) {
        if (value.until < receivedAt - 60 * 60_000) cooldowns.delete(cachedKey);
      }
      cooldowns.set(key, { until: receivedAt + delay, attempts: attempts + 1 });
      return yield* new ViewCodeGrokBillingError({ kind: "rateLimited", status: 429 });
    }
    cooldowns.delete(key);
    if (response.status === 401 || response.status === 403)
      return yield* new ViewCodeGrokBillingError({
        kind: "authentication",
        status: response.status,
      });
    if (response.status < 200 || response.status >= 300)
      return yield* new ViewCodeGrokBillingError({ kind: "http", status: response.status });
    return response;
  });
}
