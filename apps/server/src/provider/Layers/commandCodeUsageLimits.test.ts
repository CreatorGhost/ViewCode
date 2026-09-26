import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import {
  commandCodePlan,
  commandCodeUsageToLimits,
  readCommandCodeUsageLimits,
} from "./commandCodeUsageLimits.ts";

const checkedAt = "2026-09-26T00:00:00.000Z";

describe("commandCodeUsageToLimits", () => {
  it("reports dollars left and the share of an active plan already used", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: { credits: { monthlyCredits: 7.5, purchasedCredits: 0, freeCredits: 0 } },
        subscription: {
          data: {
            planId: "individual-pro-monthly",
            status: "active",
            currentPeriodEnd: "2026-10-01T00:00:00.000Z",
          },
        },
        summary: { totalCost: 22.5 },
      },
      checkedAt,
    );
    const [window] = limits.windows;
    expect(window?.label).toBe("Pro credits · $7.50 left");
    expect(window?.usedPercent).toBe(75);
    expect(window?.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("uses spend plus balance without an active plan, and reports failure without data", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: { credits: { monthlyCredits: 0, purchasedCredits: 5, freeCredits: 0 } },
        subscription: null,
        summary: { totalCost: 15 },
      },
      checkedAt,
    );
    expect(limits.windows[0]?.usedPercent).toBe(75);
    expect(limits.windows[0]?.label).toBe("Credits · $5.00 left");
    expect(
      commandCodeUsageToLimits({ credits: null, subscription: null, summary: null }, checkedAt)
        .unavailable?.reason,
    ).toBe("probeFailed");
  });

  it("matches plan ids by their longest prefix", () => {
    expect(commandCodePlan("individual-pro-v1-annual")).toEqual({
      name: "Pro",
      monthlyCredits: 80,
    });
    expect(commandCodePlan("INDIVIDUAL_MAX")).toEqual({ name: "Max", monthlyCredits: 150 });
    expect(commandCodePlan("enterprise")).toBeNull();
  });
});

const SECRET_KEY = "cc-secret-key-123";
const logText = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const captureLogs = () => {
  const entries: Array<ReadonlyArray<unknown>> = [];
  const logger = Logger.make<unknown, void>((options) => {
    entries.push(Array.isArray(options.message) ? options.message : [options.message]);
  });
  const find = (message: string) =>
    entries
      .filter((entry) => entry[0] === message)
      .map((entry) => entry[1] as Record<string, unknown>);
  return { entries, find, layer: Logger.layer([logger], { mergeWithExisting: false }) };
};

const jsonForRoute = (url: string) => {
  if (url.includes("/alpha/whoami")) return { org: { id: "org-1" } };
  if (url.includes("/alpha/billing/credits"))
    return { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } };
  if (url.includes("/alpha/billing/subscriptions")) return { data: { status: "inactive" } };
  return { totalCost: 5 };
};

/** Answers every route, or with `hang` never answers once a request arrives. */
const countingHttpClient = (hang?: Deferred.Deferred<void>) => {
  const requests: Array<string> = [];
  const client = HttpClient.make((request) => {
    requests.push(request.url);
    return hang
      ? Deferred.succeed(hang, undefined).pipe(Effect.andThen(Effect.never))
      : Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json(jsonForRoute(request.url))),
        );
  });
  return { requests, client };
};

const writeAuthFile = (contents: string | undefined) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3-command-code-credits-" });
    if (contents !== undefined) {
      yield* fs.makeDirectory(`${home}/.commandcode`, { recursive: true });
      yield* fs.writeFileString(`${home}/.commandcode/auth.json`, contents);
    }
    return home;
  });

const CREDENTIAL_LOG = "Command Code credits: read credential file (opt-in)";
const BILLING_LOG = "Command Code credits: read billing API (opt-in)";

it.layer(NodeServices.layer)("readCommandCodeUsageLimits", (it) => {
  it.effect("reuses a fresh reading without opening the key file again", () => {
    const logs = captureLogs();
    const http = countingHttpClient();
    return Effect.gen(function* () {
      const home = yield* writeAuthFile(`{ "apiKey": "${SECRET_KEY}" }`);
      const first = yield* readCommandCodeUsageLimits({ HOME: home });
      expect(first.unavailable).toBeUndefined();
      expect(logs.find(CREDENTIAL_LOG)).toEqual([
        { file: `${home}/.commandcode/auth.json`, outcome: "found" },
      ]);
      const requestsAfterFirst = http.requests.length;

      const second = yield* readCommandCodeUsageLimits({ HOME: home });
      expect(second).toEqual(first);
      expect(logs.find(CREDENTIAL_LOG)).toHaveLength(1);
      expect(http.requests).toHaveLength(requestsAfterFirst);
      expect(logText(logs.entries)).not.toContain(SECRET_KEY);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http.client), Effect.provide(logs.layer));
  });

  it.effect("logs a missing or unreadable key file and calls nothing", () => {
    const logs = captureLogs();
    const http = countingHttpClient();
    return Effect.gen(function* () {
      const missingHome = yield* writeAuthFile(undefined);
      const malformedHome = yield* writeAuthFile(`{ "apiKey": "${SECRET_KEY}"`);
      const noKeyHome = yield* writeAuthFile("{}");
      for (const home of [missingHome, malformedHome, noKeyHome]) {
        const limits = yield* readCommandCodeUsageLimits({ HOME: home });
        expect(limits.unavailable?.reason).toBe("unsupported");
      }
      expect(logs.find(CREDENTIAL_LOG).map((entry) => entry.outcome)).toEqual([
        "missing",
        "error",
        "noKey",
      ]);
      expect(http.requests).toHaveLength(0);
      expect(logText(logs.entries)).not.toContain(SECRET_KEY);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http.client), Effect.provide(logs.layer));
  });

  it.effect("logs the billing read when the API times out", () => {
    const logs = captureLogs();
    return Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const http = countingHttpClient(requested);
      const home = yield* writeAuthFile(`{ "apiKey": "${SECRET_KEY}" }`);
      const fiber = yield* readCommandCodeUsageLimits({ HOME: home }).pipe(
        Effect.provideService(HttpClient.HttpClient, http.client),
        Effect.forkChild,
      );
      yield* Deferred.await(requested);
      yield* TestClock.adjust("10 seconds");
      const limits = yield* Fiber.join(fiber);
      expect(limits.unavailable?.reason).toBe("probeFailed");
      expect(logs.find(CREDENTIAL_LOG).map((entry) => entry.outcome)).toEqual(["found"]);
      const [billing] = logs.find(BILLING_LOG);
      expect(billing?.timedOut).toBe(true);
      expect(billing?.keySource).toBe(`${home}/.commandcode/auth.json`);
      expect(logText(logs.entries)).not.toContain(SECRET_KEY);
    }).pipe(Effect.provide(logs.layer));
  });
});
