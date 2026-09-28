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
  it("uses measured monthly spend and includes the five-hour and weekly API limits", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: {
          credits: { monthlyCredits: 20, purchasedCredits: 50, freeCredits: 10 },
          windowLimits: {
            fiveHour: { used: 7, cap: 14, resetAt: 1790546400000 },
            weekly: { used: 21, cap: 35, resetAt: 1790546400 },
          },
        },
        subscription: {
          data: {
            planId: "individual-goat",
            status: "active",
            currentPeriodEnd: "2026-10-01T00:00:00Z",
          },
        },
        summary: { totalCost: 60 },
      },
      checkedAt,
    );
    expect(limits.windows).toMatchObject([
      { id: "fiveHour", kind: "session", usedPercent: 50, resetsAt: "2026-09-27T22:00:00.000Z" },
      { id: "weekly", kind: "weekly", usedPercent: 60, resetsAt: "2026-09-27T22:00:00.000Z" },
      { id: "credits", kind: "monthly", usedPercent: 75, label: "GOAT monthly · $20.00 left" },
    ]);
  });

  it("does not invent monthly usage when billing reads fail", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: null,
        subscription: { data: { planId: "individual-goat", status: "active" } },
        summary: null,
      },
      checkedAt,
    );
    expect(limits.unavailable?.reason).toBe("probeFailed");
    expect(limits.windows).toEqual([]);
  });

  it("omits zero-cap windows and absent reset timestamps", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: {
          credits: { monthlyCredits: 0 },
          windowLimits: {
            fiveHour: { used: 1, cap: 0, resetAt: 0 },
            weekly: { used: 0, cap: 35, resetAt: 0 },
          },
        },
        subscription: null,
        summary: { totalCost: 0 },
      },
      checkedAt,
    );
    expect(limits.windows).toEqual([
      { id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 0, windowDurationMins: 10080 },
    ]);
  });
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
    expect(window?.label).toBe("Pro monthly · $7.50 left");
    expect(window?.usedPercent).toBe(75);
    expect(window?.resetsAt).toBe("2026-10-01T00:00:00.000Z");
  });

  it("uses spend plus balance without an active plan, and reports failure without data", () => {
    const limits = commandCodeUsageToLimits(
      {
        credits: { credits: { monthlyCredits: 5, purchasedCredits: 10, freeCredits: 0 } },
        subscription: null,
        summary: { totalCost: 15 },
      },
      checkedAt,
    );
    expect(limits.windows[0]?.usedPercent).toBe(75);
    expect(limits.windows[0]?.label).toBe("Monthly · $5.00 left");
    expect(
      commandCodeUsageToLimits({ credits: null, subscription: null, summary: null }, checkedAt)
        .unavailable?.reason,
    ).toBe("probeFailed");
  });

  it("matches plan ids by their longest prefix", () => {
    expect(commandCodePlan("individual-pro-v1-annual")).toEqual({
      name: "Pro",
    });
    expect(commandCodePlan("INDIVIDUAL_MAX")).toEqual({ name: "Max" });
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

const CREDENTIAL_LOG = "Command Code credits: read credential file (enabled)";
const BILLING_LOG = "Command Code credits: read billing API (enabled)";

it.layer(NodeServices.layer)("readCommandCodeUsageLimits", (it) => {
  it.effect("stops after a rejected identity read instead of querying an unknown account", () =>
    Effect.gen(function* () {
      const home = yield* writeAuthFile(`{ "apiKey": "${SECRET_KEY}" }`);
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, new Response(null, { status: 401 })),
        );
      });
      const limits = yield* readCommandCodeUsageLimits({ HOME: home }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(limits.unavailable?.message).toContain("Sign in");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain("/whoami");
    }),
  );

  it.effect("honors a rate-limit cooldown without making another billing request", () =>
    Effect.gen(function* () {
      const home = yield* writeAuthFile('{ "apiKey": "rate-limited-cc-account" }');
      const requests: string[] = [];
      const client = HttpClient.make((request) => {
        requests.push(request.url);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(null, { status: 429, headers: { "Retry-After": "120" } }),
          ),
        );
      });
      const read = readCommandCodeUsageLimits({ HOME: home }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect((yield* read).unavailable?.message).toContain("limiting usage requests");
      yield* TestClock.adjust("60 seconds");
      yield* read;
      expect(requests).toHaveLength(1);
      yield* TestClock.adjust("60 seconds");
      yield* read;
      expect(requests).toHaveLength(2);
    }),
  );

  it.effect("reads API windows with desktop headers and a numeric billing period", () =>
    Effect.gen(function* () {
      const home = yield* writeAuthFile(`{ "apiKey": "${SECRET_KEY}" }`);
      const requests: Array<string> = [];
      const client = HttpClient.make((request) => {
        expect(request.headers["user-agent"]).toBe("command-code-desktop");
        expect(request.headers["x-command-code-version"]).toBe("desktop");
        expect(request.headers.authorization).toBe(`Bearer ${SECRET_KEY}`);
        requests.push(request.url);
        const body = request.url.includes("/subscriptions")
          ? { planId: "individual-goat", currentPeriodStart: 1790546400 }
          : request.url.includes("/credits")
            ? {
                credits: { monthlyCredits: 20 },
                windowLimits: { fiveHour: { used: 7, cap: 14, resetAt: 0 } },
              }
            : request.url.includes("/summary")
              ? { totalCost: 60 }
              : { org: { id: "org-1" } };
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body)));
      });
      const limits = yield* readCommandCodeUsageLimits({ HOME: home }).pipe(
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(limits.windows.map((window) => [window.id, window.usedPercent])).toEqual([
        ["fiveHour", 50],
        ["credits", 75],
      ]);
      const summary = new URL(requests.find((url) => url.includes("/summary"))!);
      expect(summary.searchParams.get("orgId")).toBe("org-1");
      expect(summary.searchParams.get("since")).toBe("2026-09-27T22:00:00.000Z");
    }),
  );

  it.effect("reuses a fresh reading while checking the current login", () => {
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
      expect(logs.find(CREDENTIAL_LOG)).toHaveLength(2);
      expect(http.requests).toHaveLength(requestsAfterFirst);
      expect(logText(logs.entries)).not.toContain(SECRET_KEY);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http.client), Effect.provide(logs.layer));
  });

  it.effect("does not reuse another account's cached usage after login changes or signout", () => {
    const http = countingHttpClient();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* writeAuthFile('{ "apiKey": "old-account" }');
      yield* readCommandCodeUsageLimits({ HOME: home });
      const count = http.requests.length;
      yield* fs.writeFileString(`${home}/.commandcode/auth.json`, '{ "apiKey": "new-account" }');
      yield* readCommandCodeUsageLimits({ HOME: home });
      expect(http.requests.length).toBe(count * 2);
      yield* fs.remove(`${home}/.commandcode/auth.json`);
      expect((yield* readCommandCodeUsageLimits({ HOME: home })).unavailable?.message).toContain(
        "Sign in",
      );
      expect(http.requests.length).toBe(count * 2);
    }).pipe(Effect.provideService(HttpClient.HttpClient, http.client));
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
        expect(limits.unavailable?.reason).toBe("probeFailed");
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
      expect(billing?.result).toBe("unavailable (probeFailed)");
      expect(limits.unavailable?.message).toMatch(/could not be reached|could not read/);
      expect(billing?.keySource).toBe(`${home}/.commandcode/auth.json`);
      expect(logText(logs.entries)).not.toContain(SECRET_KEY);
    }).pipe(Effect.provide(logs.layer));
  });
});
