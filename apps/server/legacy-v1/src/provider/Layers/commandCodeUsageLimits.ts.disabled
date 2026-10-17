import * as NodeOS from "node:os";
import * as NodeCrypto from "node:crypto";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";
import { makeUsageHttpReader, UsageHttpError } from "../usageHttp.ts";

const isUsageHttpError = Schema.is(UsageHttpError);

/** What the usage popover shows for Command Code: where to see credits. */
export function commandCodeUsagePointer(checkedAt: string) {
  return makeUnavailableUsageLimits({
    checkedAt,
    reason: "unsupported",
    message:
      "Usage reading is turned off. Enable Show credits in the usage popover in Settings → Providers → Command Code.",
  });
}

/**
 * Command Code's own `/usage` screen reads these endpoints with the key the
 * CLI stores in ~/.commandcode/auth.json (or COMMAND_CODE_API_KEY). Every read
 * of that file is logged (path and outcome, never the key). Like CodeNotch,
 * use measured monthly spend and the returned window caps, not plan estimates.
 */
const COMMAND_CODE_API = "https://api.commandcode.ai";
const PLAN_NAMES: ReadonlyArray<readonly [prefix: string, name: string]> = [
  ["individual-provider", "Provider"],
  ["individual-pro-v1", "Pro"],
  ["individual-ultra", "Ultra"],
  ["individual-goat", "GOAT"],
  ["individual-max", "Max"],
  ["individual-pro", "Pro"],
  ["individual-go", "Go"],
  ["teams-pro", "Teams Pro"],
];

const AuthFile = Schema.Struct({ apiKey: Schema.optional(Schema.String) });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const Whoami = Schema.Struct({
  org: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String) }))),
});
const ResetTime = Schema.NullOr(Schema.Union([Schema.String, Schema.Number]));
const UsageWindow = Schema.Struct({
  used: Schema.optional(Schema.NullOr(Schema.Number)),
  cap: Schema.optional(Schema.NullOr(Schema.Number)),
  resetAt: Schema.optional(ResetTime),
});
const Credits = Schema.Struct({
  credits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        monthlyCredits: Schema.optional(Schema.NullOr(Schema.Number)),
        purchasedCredits: Schema.optional(Schema.NullOr(Schema.Number)),
        freeCredits: Schema.optional(Schema.NullOr(Schema.Number)),
      }),
    ),
  ),
  windowLimits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        fiveHour: Schema.optional(Schema.NullOr(UsageWindow)),
        weekly: Schema.optional(Schema.NullOr(UsageWindow)),
      }),
    ),
  ),
});
const subscriptionFields = {
  planId: Schema.optional(Schema.NullOr(Schema.String)),
  status: Schema.optional(Schema.NullOr(Schema.String)),
  currentPeriodStart: Schema.optional(ResetTime),
  currentPeriodEnd: Schema.optional(ResetTime),
};
const Subscription = Schema.Struct({
  ...subscriptionFields,
  data: Schema.optional(Schema.NullOr(Schema.Struct(subscriptionFields))),
});
const Summary = Schema.Struct({ totalCost: Schema.optional(Schema.NullOr(Schema.Number)) });

export interface CommandCodeUsage {
  readonly credits: typeof Credits.Type | null;
  readonly subscription: typeof Subscription.Type | null;
  readonly summary: typeof Summary.Type | null;
}

export function commandCodePlan(planId: string | null | undefined) {
  if (!planId) return null;
  const normalized = planId.toLowerCase().replace(/_/g, "-");
  const match = PLAN_NAMES.find(([prefix]) => normalized.startsWith(prefix));
  return match ? { name: match[1] } : null;
}

/** API timestamps can be ISO strings, Unix seconds, or Unix milliseconds. */
function resetTime(value: string | number | null | undefined): string | undefined {
  if (value == null || value === 0) return undefined;
  const millis =
    typeof value === "string" ? Date.parse(value) : value > 1e12 ? value : value * 1000;
  const date = DateTime.make(millis);
  return Option.isSome(date) && millis > 0 ? DateTime.formatIso(date.value) : undefined;
}

export function commandCodeUsageToLimits(usage: CommandCodeUsage, checkedAt: string) {
  const subscription = usage.subscription?.data ?? usage.subscription;
  const plan = commandCodePlan(subscription?.planId);
  const monthly = usage.credits?.credits?.monthlyCredits;
  const spent = usage.summary?.totalCost;
  const windows: ServerProviderUsageWindow[] = [];
  // Purchased/free credits are separate balances, not part of the monthly cap.
  if (monthly != null && spent != null && Number.isFinite(monthly) && Number.isFinite(spent)) {
    const remaining = Math.max(0, monthly);
    const used = Math.max(0, spent);
    const total = used + remaining;
    if (total > 0) {
      const resetsAt = resetTime(subscription?.currentPeriodEnd);
      windows.push({
        id: "credits",
        kind: "monthly",
        label: `${plan ? `${plan.name} monthly` : "Monthly"} · $${remaining.toFixed(2)} left`,
        usedPercent: clampPercent((used / total) * 100),
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }
  for (const [id, kind, label, minutes] of [
    ["fiveHour", "session", "5-hour", 300],
    ["weekly", "weekly", "Weekly", 10080],
  ] as const) {
    const entry = usage.credits?.windowLimits?.[id];
    if (!entry?.cap || !Number.isFinite(entry.cap) || entry.cap <= 0) continue;
    const resetsAt = resetTime(entry.resetAt);
    windows.push({
      id,
      kind,
      label,
      usedPercent: clampPercent(((entry.used ?? 0) / entry.cap) * 100),
      windowDurationMins: minutes,
      ...(resetsAt ? { resetsAt } : {}),
    });
  }
  return windows.length > 0
    ? makeUsageLimits({ checkedAt, windows })
    : makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message:
          "Command Code did not return usage limits. Sign in to Command Code and refresh usage.",
      });
}

// These endpoints are unofficial, so read them gently: a successful reading
// is reused for a few minutes however often the provider status refreshes.
// Recheck the ordinary credential file before using a cache entry so account
// switching and sign-out cannot briefly show the previous account's balance.
const USAGE_CACHE_MS = 5 * 60_000;
const readUsageHttp = makeUsageHttpReader();
const usageCache = new Map<
  string,
  { readonly at: number; readonly limits: ReturnType<typeof commandCodeUsageToLimits> }
>();

type AuthFileOutcome = "found" | "missing" | "noKey" | "error";

/**
 * Reads the key Command Code's CLI stores, and logs that the file was read
 * (path and outcome, never the key) whatever happens after.
 */
const readAuthFileKey = Effect.fn("readCommandCodeAuthFileKey")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const { outcome, apiKey } = yield* fs.readFileString(file).pipe(
    Effect.flatMap(decodeAuthFile),
    Effect.map(({ apiKey }) => {
      const trimmed = apiKey?.trim();
      return trimmed
        ? { outcome: "found" as AuthFileOutcome, apiKey: trimmed }
        : { outcome: "noKey" as AuthFileOutcome, apiKey: undefined };
    }),
    Effect.catch((error) =>
      Effect.succeed({
        outcome: (error instanceof PlatformError.PlatformError && error.reason._tag === "NotFound"
          ? "missing"
          : "error") as AuthFileOutcome,
        apiKey: undefined,
      }),
    ),
  );
  yield* Effect.logInfo("Command Code credits: read credential file (enabled)", {
    file,
    outcome,
  });
  return apiKey;
});

export const readCommandCodeUsageLimits = Effect.fn("readCommandCodeUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const nowMs = Date.parse(checkedAt);
  const path = yield* Path.Path;
  const envKey = environment.COMMAND_CODE_API_KEY?.trim() || undefined;
  const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
  const authFile = path.join(home, ".commandcode", "auth.json");

  const apiKey = envKey ?? (yield* readAuthFileKey(authFile));
  if (!apiKey)
    return makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Sign in to Command Code to see usage here.",
    });
  const cacheKey = NodeCrypto.createHash("sha256")
    .update(authFile)
    .update("\0")
    .update(apiKey)
    .digest("hex");
  const cached = usageCache.get(cacheKey);
  if (cached && nowMs - cached.at < USAGE_CACHE_MS) return cached.limits;
  for (const [key, entry] of usageCache) {
    if (nowMs - entry.at >= USAGE_CACHE_MS) usageCache.delete(key);
  }
  const keySource = envKey ? "COMMAND_CODE_API_KEY" : authFile;
  const calls: Array<{ readonly route: string; readonly status: number | "error" }> = [];

  const get = <S extends Schema.Top>(
    schema: S,
    route: string,
    params: Record<string, string | null>,
  ) => {
    const query = new URLSearchParams(
      Object.entries(params).flatMap(([key, value]): Array<[string, string]> =>
        value ? [[key, value]] : [],
      ),
    ).toString();
    return readUsageHttp({
      provider: "Command Code",
      credential: apiKey,
      request: HttpClientRequest.get(`${COMMAND_CODE_API}${route}${query ? `?${query}` : ""}`).pipe(
        HttpClientRequest.bearerToken(apiKey),
        HttpClientRequest.setHeader("User-Agent", "command-code-desktop"),
        HttpClientRequest.setHeader("x-command-code-version", "desktop"),
        HttpClientRequest.setHeader("Accept", "application/json"),
      ),
    }).pipe(
      Effect.tap((response) => Effect.sync(() => calls.push({ route, status: response.status }))),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (!calls.some((call) => call.route === route))
            calls.push({
              route,
              status: isUsageHttpError(error) ? (error.status ?? "error") : "error",
            });
        }),
      ),
    );
  };
  const reading = yield* Effect.gen(function* () {
    const whoami = yield* get(Whoami, "/alpha/whoami", { limits: "1" });
    const orgId = whoami?.org?.id ?? null;
    const [credits, subscription] = yield* Effect.all(
      [
        get(Credits, "/alpha/billing/credits", { orgId }),
        get(Subscription, "/alpha/billing/subscriptions", { orgId }),
      ],
      { concurrency: 2 },
    );
    const summary = yield* get(Summary, "/alpha/usage/summary", {
      orgId,
      since: resetTime((subscription?.data ?? subscription)?.currentPeriodStart) ?? null,
    });
    return commandCodeUsageToLimits({ credits, subscription, summary }, checkedAt);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed(
        makeUnavailableUsageLimits({
          checkedAt,
          reason: "probeFailed",
          message: isUsageHttpError(error)
            ? error.message
            : "Command Code returned an unreadable usage response. Try again later.",
        }),
      ),
    ),
    Effect.timeoutOption("10 seconds"),
  );
  const limits = Option.getOrElse(reading, () =>
    makeUnavailableUsageLimits({
      checkedAt,
      reason: "probeFailed",
      message: "Command Code could not read its credits.",
    }),
  );
  if (!limits.unavailable) usageCache.set(cacheKey, { at: nowMs, limits });
  // Never logs the key or account details: only where the key came from,
  // which endpoints were called and how they answered (a timeout included).
  yield* Effect.logInfo("Command Code credits: read billing API (enabled)", {
    keySource,
    host: COMMAND_CODE_API,
    calls,
    ...(Option.isNone(reading) ? { timedOut: true } : {}),
    result: limits.unavailable ? `unavailable (${limits.unavailable.reason})` : "ok",
  });
  return limits;
});
