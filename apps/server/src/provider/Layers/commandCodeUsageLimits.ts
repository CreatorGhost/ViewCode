import * as NodeOS from "node:os";
import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "../providerUsageLimits.ts";

/**
 * Command Code's own `/usage` screen reads these endpoints with the key the
 * CLI stores in ~/.commandcode/auth.json (or COMMAND_CODE_API_KEY). The plan
 * table and the used-percentage formula mirror the CLI's, so the bar matches
 * what `cmd` shows.
 */
const COMMAND_CODE_API = "https://api.commandcode.ai";
const PLAN_CREDITS: ReadonlyArray<readonly [prefix: string, name: string, credits: number]> = [
  ["individual-provider", "Provider", 15],
  ["individual-pro-v1", "Pro", 80],
  ["individual-ultra", "Ultra", 300],
  ["individual-goat", "GOAT", 70],
  ["individual-max", "Max", 150],
  ["individual-pro", "Pro", 30],
  ["individual-go", "Go", 10],
  ["teams-pro", "Teams Pro", 40],
];

const AuthFile = Schema.Struct({ apiKey: Schema.optional(Schema.String) });
const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const Whoami = Schema.Struct({
  org: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String) }))),
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
});
const Subscription = Schema.Struct({
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        planId: Schema.optional(Schema.NullOr(Schema.String)),
        status: Schema.optional(Schema.NullOr(Schema.String)),
        currentPeriodStart: Schema.optional(Schema.NullOr(Schema.String)),
        currentPeriodEnd: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
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
  const match = PLAN_CREDITS.find(([prefix]) => normalized.startsWith(prefix));
  return match ? { name: match[1], monthlyCredits: match[2] } : null;
}

/** One "credits" window: dollars left this period and the share already used. */
export function commandCodeUsageToLimits(usage: CommandCodeUsage, checkedAt: string) {
  const subscription = usage.subscription?.data ?? null;
  const plan = commandCodePlan(subscription?.planId);
  const balance = usage.credits?.credits;
  const monthly = Math.max(0, balance?.monthlyCredits ?? 0);
  const purchased = Math.max(0, balance?.purchasedCredits ?? 0);
  const free = Math.max(0, balance?.freeCredits ?? 0);
  const remaining = monthly + purchased + free;
  const spent = Math.max(0, usage.summary?.totalCost ?? 0);
  if (!usage.credits && !usage.subscription) {
    return makeUnavailableUsageLimits({ checkedAt, reason: "probeFailed" });
  }
  const planCredits = subscription?.status === "active" ? (plan?.monthlyCredits ?? null) : null;
  const total =
    planCredits !== null ? Math.max(planCredits, monthly) + purchased + free : spent + remaining;
  const usedPercent =
    total > 0 && (remaining > 0 || spent > 0) ? ((total - remaining) / total) * 100 : 0;
  const window: ServerProviderUsageWindow = {
    id: "credits",
    kind: "monthly",
    label: `${plan ? `${plan.name} credits` : "Credits"} · $${remaining.toFixed(2)} left`,
    usedPercent: clampPercent(usedPercent),
    ...(subscription?.currentPeriodEnd ? { resetsAt: subscription.currentPeriodEnd } : {}),
  };
  return makeUsageLimits({ checkedAt, windows: [window] });
}

// These endpoints are unofficial, so read them gently: a successful reading
// is reused for a few minutes however often the provider status refreshes.
const USAGE_CACHE_MS = 5 * 60_000;
const usageCache = new Map<
  string,
  { readonly at: number; readonly limits: ReturnType<typeof commandCodeUsageToLimits> }
>();

export const readCommandCodeUsageLimits = Effect.fn("readCommandCodeUsageLimits")(function* (
  environment: NodeJS.ProcessEnv = process.env,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const nowMs = Date.parse(checkedAt);
  return yield* Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    let apiKey = environment.COMMAND_CODE_API_KEY?.trim();
    if (!apiKey) {
      const home = environment.HOME || environment.USERPROFILE || NodeOS.homedir();
      const raw = yield* fs
        .readFileString(path.join(home, ".commandcode", "auth.json"))
        .pipe(Effect.orElseSucceed(() => "{}"));
      apiKey = (yield* decodeAuthFile(raw).pipe(
        Effect.orElseSucceed(() => ({ apiKey: undefined })),
      )).apiKey?.trim();
    }
    if (!apiKey) return makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
    const cached = usageCache.get(apiKey);
    if (cached && nowMs - cached.at < USAGE_CACHE_MS) return cached.limits;

    const client = yield* HttpClient.HttpClient;
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
      return client
        .execute(
          HttpClientRequest.get(`${COMMAND_CODE_API}${route}${query ? `?${query}` : ""}`).pipe(
            HttpClientRequest.bearerToken(apiKey!),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
          Effect.orElseSucceed(() => null),
        );
    };
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
      since: subscription?.data?.currentPeriodStart ?? null,
    });
    const limits = commandCodeUsageToLimits({ credits, subscription, summary }, checkedAt);
    if (!limits.unavailable) usageCache.set(apiKey, { at: nowMs, limits });
    return limits;
  }).pipe(
    Effect.timeout("10 seconds"),
    Effect.orElseSucceed(() =>
      makeUnavailableUsageLimits({
        checkedAt,
        reason: "probeFailed",
        message: "Command Code could not read its credits.",
      }),
    ),
  );
});
