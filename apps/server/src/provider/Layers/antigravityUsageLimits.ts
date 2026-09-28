import type {
  AntigravityAuthMethod,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";
import { makeUsageHttpReader } from "../usageHttp.ts";

const maybeString = Schema.optionalKey(Schema.NullOr(Schema.String));
const maybeNumber = Schema.optionalKey(Schema.NullOr(Schema.Finite));
const Bucket = Schema.Struct({
  bucketId: maybeString,
  modelId: maybeString,
  name: maybeString,
  displayName: maybeString,
  window: maybeString,
  resetTime: maybeString,
  remainingFraction: maybeNumber,
  used: maybeNumber,
  limit: maybeNumber,
  disabled: Schema.optionalKey(Schema.Boolean),
  remaining: Schema.optionalKey(
    Schema.NullOr(
      Schema.Struct({
        remainingFraction: maybeNumber,
        case: maybeString,
        value: maybeNumber,
      }),
    ),
  ),
});
const Group = Schema.Struct({
  displayName: maybeString,
  buckets: Schema.optionalKey(Schema.Array(Bucket)),
});
const Groups = Schema.Struct({ groups: Schema.optionalKey(Schema.Array(Group)) });
const Quotas = Schema.Struct({
  buckets: Schema.optionalKey(Schema.Array(Bucket)),
  groups: Schema.optionalKey(Schema.Array(Group)),
  quotaGroups: Schema.optionalKey(Schema.Array(Group)),
  response: Schema.optionalKey(Groups),
  summary: Schema.optionalKey(Groups),
});
const decodeQuotas = Schema.decodeUnknownOption(Quotas);
const Credentials = Schema.Struct({
  client_id: Schema.NonEmptyString,
  client_secret: Schema.NonEmptyString,
  refresh_token: Schema.NonEmptyString,
  project_id: maybeString,
});
const decodeCredentials = Schema.decodeEffect(Schema.fromJsonString(Credentials));
const AccessToken = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Finite,
});

/** Google quota envelopes also consumed by CodeNotch's AntigravityQuotaParser.
 * Keep unnamed/model-specific windows honest: reset distance alone does not establish cadence. */
export function antigravityUsageToLimits(
  value: unknown,
  checkedAt: string,
): ServerProviderUsageLimits {
  const decoded = decodeQuotas(value);
  const windows: ServerProviderUsageWindow[] = [];
  if (Option.isSome(decoded)) {
    const body = decoded.value;
    const groups =
      body.response?.groups ?? body.summary?.groups ?? body.groups ?? body.quotaGroups ?? [];
    const entries =
      groups.length > 0
        ? groups.flatMap((group) =>
            (group.buckets ?? []).map((bucket) => ({ bucket, group: group.displayName })),
          )
        : (body.buckets ?? []).map((bucket) => ({ bucket, group: undefined }));
    for (const { bucket, group } of entries) {
      if (bucket.disabled) continue;
      const remaining =
        bucket.remainingFraction ??
        bucket.remaining?.remainingFraction ??
        (bucket.remaining?.case === "remainingFraction" ? bucket.remaining.value : undefined);
      const used =
        remaining != null && remaining >= 0 && remaining <= 1
          ? (1 - remaining) * 100
          : bucket.limit != null && bucket.limit > 0 && bucket.used != null && bucket.used >= 0
            ? (bucket.used / bucket.limit) * 100
            : undefined;
      if (used === undefined) continue;
      const name = bucket.bucketId || bucket.modelId || bucket.name || bucket.displayName;
      if (!name) continue;
      const cadence = `${bucket.window ?? ""} ${bucket.bucketId ?? ""} ${bucket.displayName ?? ""}`
        .toLowerCase()
        .replaceAll("_", "-");
      const kind = /\bweekly\b/.test(cadence)
        ? "weekly"
        : /\b(5h|5-hour|five.hour|hourly|session)\b/.test(cadence)
          ? "session"
          : "other";
      const reset = bucket.resetTime ? DateTime.make(bucket.resetTime) : Option.none();
      const id = group ? `${group}:${name}` : name;
      if (windows.some((window) => window.id === id)) continue;
      windows.push({
        id,
        kind,
        label: [group, (bucket.displayName || name).replace(/ Remaining$/, "")]
          .filter(Boolean)
          .join(" · "),
        usedPercent: clampPercent(used),
        ...(kind === "weekly"
          ? { windowDurationMins: 10080 }
          : /\b(5h|5-hour|five.hour)\b/.test(cadence)
            ? { windowDurationMins: 300 }
            : {}),
        ...(Option.isSome(reset) ? { resetsAt: DateTime.formatIso(reset.value) } : {}),
      });
    }
  }
  return windows.length
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message:
          "Google did not return quota windows for this Antigravity account. Check usage in Antigravity.",
      });
}

/** One instance, one ACP profile. Never fall back to another app's Google account or Keychain. */
export function makeAntigravityUsageReader(input: {
  readonly profileDirectory: string;
  readonly authMethod: AntigravityAuthMethod;
}) {
  const request = makeUsageHttpReader();
  let cached: { source: string; until: number; value: ServerProviderUsageLimits } | undefined;
  let token: { source: string; until: number; value: string } | undefined;
  return Effect.fn("readAntigravityUsageLimits")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (input.authMethod !== "oauth-personal")
      return makeUnavailableUsageLimits({
        checkedAt,
        reason: "unsupported",
        message:
          input.authMethod === "oauth-business"
            ? "Gemini Enterprise quotas are managed by your organization. Check the Google Cloud console."
            : "API-key and Agent Platform quotas are managed in Google AI Studio or Google Cloud, rather than Antigravity subscription usage.",
      });
    return yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* fs.readFileString(
        path.join(input.profileDirectory, "antigravity-acp", "acp_token.json"),
      );
      const credentials = yield* decodeCredentials(source);
      if (cached?.source === source && cached.until > now) return cached.value;
      if (token?.source !== source || token.until <= now) {
        const response = yield* request({
          provider: "Antigravity",
          credential: credentials.refresh_token,
          authMessage: "Antigravity sign-in expired. Sign in again in provider settings.",
          request: HttpClientRequest.post("https://oauth2.googleapis.com/token").pipe(
            HttpClientRequest.bodyUrlParams({
              client_id: credentials.client_id,
              client_secret: credentials.client_secret,
              refresh_token: credentials.refresh_token,
              grant_type: "refresh_token",
            }),
          ),
          allowedStatuses: [400],
        });
        if (response.status === 400)
          return makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message:
              "Google could not refresh this Antigravity sign-in. Sign in again in provider settings.",
          });
        const body = yield* HttpClientResponse.schemaBodyJson(AccessToken)(response);
        token = {
          source,
          value: body.access_token,
          until: now + Math.max(0, body.expires_in - 60) * 1000,
        };
      }
      const response = yield* request({
        provider: "Antigravity",
        credential: credentials.refresh_token,
        authMessage:
          "Google did not authorize quota access for this Antigravity account. Check your Google plan or organization policy.",
        request: HttpClientRequest.post(
          "https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary",
        ).pipe(
          HttpClientRequest.bearerToken(token.value),
          HttpClientRequest.setHeader("User-Agent", "antigravity/hub/2.8.0"),
          HttpClientRequest.setHeader(
            "Client-Metadata",
            "ideType=IDE_UNSPECIFIED,platform=PLATFORM_UNSPECIFIED,pluginType=GEMINI",
          ),
          HttpClientRequest.bodyJsonUnsafe(
            credentials.project_id ? { project: credentials.project_id } : {},
          ),
        ),
      });
      const value = antigravityUsageToLimits(yield* response.json, checkedAt);
      if (!value.unavailable) cached = { source, until: now + 5 * 60_000, value };
      return value;
    }).pipe(
      Effect.catch((error) => {
        cached = undefined;
        token = undefined;
        return Effect.succeed(
          makeUnavailableUsageLimits({
            checkedAt,
            reason: "probeFailed",
            message:
              error._tag === "UsageHttpError"
                ? error.message
                : error._tag === "PlatformError"
                  ? "Sign in to this Antigravity provider in Settings to read its usage."
                  : "Antigravity usage could not be read. Refresh usage or sign in again in provider settings.",
          }),
        );
      }),
    );
  });
}
