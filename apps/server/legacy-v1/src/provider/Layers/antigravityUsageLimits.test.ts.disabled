import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { antigravityUsageToLimits, makeAntigravityUsageReader } from "./antigravityUsageLimits.ts";

const checkedAt = "2026-09-28T00:00:00.000Z";
const quota = {
  groups: [
    {
      displayName: "Gemini Models",
      buckets: [
        {
          bucketId: "five-hour",
          displayName: "5-hour Limit",
          remainingFraction: 0.75,
          resetTime: "2026-09-28T05:00:00Z",
        },
        { bucketId: "weekly", remaining: { case: "remainingFraction", value: 0.5 } },
      ],
    },
  ],
};
describe("antigravityUsageToLimits", () => {
  it("does not assume an hourly or session bucket lasts five hours", () => {
    const limits = antigravityUsageToLimits(
      {
        buckets: [
          { bucketId: "gemini-hourly", remainingFraction: 0.5 },
          { bucketId: "gemini-session", remainingFraction: 0.5 },
        ],
      },
      checkedAt,
    );
    expect(limits.windows).toHaveLength(2);
    expect(
      limits.windows.every(
        (window) => window.kind === "session" && window.windowDurationMins === undefined,
      ),
    ).toBe(true);
  });
  it("reads grouped Google quotas with fractions and reset times", () => {
    expect(antigravityUsageToLimits(quota, checkedAt).windows).toEqual([
      {
        id: "Gemini Models:five-hour",
        label: "Gemini Models · 5-hour Limit",
        kind: "session",
        usedPercent: 25,
        windowDurationMins: 300,
        resetsAt: "2026-09-28T05:00:00.000Z",
      },
      {
        id: "Gemini Models:weekly",
        label: "Gemini Models · weekly",
        kind: "weekly",
        usedPercent: 50,
        windowDurationMins: 10080,
      },
    ]);
  });
  it.each(["response", "summary"])("accepts the %s envelope", (key) => {
    expect(antigravityUsageToLimits({ [key]: quota }, checkedAt).windows).toHaveLength(2);
  });
  it("keeps group IDs distinct and reads counts against actual caps", () => {
    const groups = ["Gemini Models", "Claude and GPT models"].map((displayName) => ({
      displayName,
      buckets: [{ bucketId: "weekly", used: 3, limit: 4 }],
    }));
    const windows = antigravityUsageToLimits({ quotaGroups: groups }, checkedAt).windows;
    expect(new Set(windows.map((w) => w.id)).size).toBe(2);
    expect(windows.map((w) => w.usedPercent)).toEqual([75, 75]);
  });
  it("does not fabricate quota or cadence for missing or invalid fields", () => {
    expect(
      antigravityUsageToLimits(
        {
          buckets: [
            { modelId: "disabled", disabled: true, remainingFraction: 0.5 },
            { modelId: "bad", remainingFraction: 2 },
            { modelId: "zero", used: 1, limit: 0 },
          ],
        },
        checkedAt,
      ).unavailable?.reason,
    ).toBe("probeFailed");
    expect(
      antigravityUsageToLimits(
        {
          buckets: [
            { modelId: "gemini-pro", remainingFraction: 0, resetTime: "2026-10-01T00:00:00Z" },
          ],
        },
        checkedAt,
      ).windows[0],
    ).toMatchObject({ id: "gemini-pro", kind: "other", usedPercent: 100 });
  });
});

const encodeFixture = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
const makeProfile = Effect.fnUntraced(function* (project: string) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-quota-" });
  yield* fs.makeDirectory(`${directory}/antigravity-acp`);
  const source = yield* encodeFixture({
    client_id: "fixture-client",
    client_secret: "fixture-secret",
    refresh_token: project,
    project_id: project,
  });
  const authPath = `${directory}/antigravity-acp/acp_token.json`;
  yield* fs.writeFileString(authPath, source);
  return { directory, source, authPath };
});

it.layer(NodeServices.layer)("Antigravity profile usage", (it) => {
  it.effect("refreshes the selected profile in memory, caches and never writes credentials", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profile = yield* makeProfile("project-one");
      const urls: string[] = [];
      const client = HttpClient.make((request) => {
        urls.push(request.url);
        if (request.url.includes("oauth2.googleapis.com")) {
          expect(request.method).toBe("POST");
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: "fixture-access", expires_in: 3600 }),
            ),
          );
        }
        expect(request.headers.authorization).toBe("Bearer fixture-access");
        if (request.body._tag === "Uint8Array")
          expect(new TextDecoder().decode(request.body.body)).toBe('{"project":"project-one"}');
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(quota)));
      });
      const read = makeAntigravityUsageReader({
        profileDirectory: profile.directory,
        authMethod: "oauth-personal",
      });
      const first = yield* read().pipe(Effect.provideService(HttpClient.HttpClient, client));
      const second = yield* read().pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(first.windows).toHaveLength(2);
      expect(second).toEqual(first);
      expect(urls).toHaveLength(2);
      yield* TestClock.adjust("5 minutes");
      yield* read().pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(urls).toHaveLength(3);
      expect(yield* fs.readFileString(profile.authPath)).toBe(profile.source);
      yield* fs.remove(profile.authPath);
      expect(
        (yield* read().pipe(Effect.provideService(HttpClient.HttpClient, client))).unavailable
          ?.message,
      ).toContain("Sign in");
      expect(urls).toHaveLength(3);
    }),
  );
  it.effect("does not use another profile's cached quota or token", () =>
    Effect.gen(function* () {
      const one = yield* makeProfile("one");
      const two = yield* makeProfile("two");
      const tokens: string[] = [];
      let refreshes = 0;
      const client = HttpClient.make((request) => {
        if (request.url.includes("oauth2.googleapis.com"))
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json({ access_token: `access-${++refreshes}`, expires_in: 3600 }),
            ),
          );
        tokens.push(request.headers.authorization!);
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(quota)));
      });
      for (const profile of [one, two])
        yield* makeAntigravityUsageReader({
          profileDirectory: profile.directory,
          authMethod: "oauth-personal",
        })().pipe(Effect.provideService(HttpClient.HttpClient, client));
      expect(tokens).toEqual(["Bearer access-1", "Bearer access-2"]);
    }),
  );
  it.effect("does not read credentials or request subscription quotas for other auth modes", () =>
    Effect.gen(function* () {
      for (const authMethod of ["oauth-business", "gemini-api-key", "agent-platform"] as const) {
        const result = yield* makeAntigravityUsageReader({
          profileDirectory: "/nonexistent",
          authMethod,
        })();
        expect(result.unavailable?.reason).toBe("unsupported");
      }
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("unexpected request")),
      ),
    ),
  );
  it.effect("explains denied quota access and revoked refresh tokens", () =>
    Effect.gen(function* () {
      const profile = yield* makeProfile("denied");
      for (const deniedRefresh of [false, true]) {
        const client = HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              request.url.includes("oauth2.googleapis.com")
                ? deniedRefresh
                  ? Response.json({ error: "invalid_grant" }, { status: 400 })
                  : Response.json({ access_token: "fixture", expires_in: 3600 })
                : Response.json({}, { status: 403 }),
            ),
          ),
        );
        const value = yield* makeAntigravityUsageReader({
          profileDirectory: profile.directory,
          authMethod: "oauth-personal",
        })().pipe(Effect.provideService(HttpClient.HttpClient, client));
        expect(value.unavailable?.message).toContain(
          deniedRefresh ? "Sign in again" : "organization policy",
        );
      }
    }),
  );
});
