import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/unstable/http";
import { describe, expect, it } from "vite-plus/test";

import { makeCachedKeychainSecretReader } from "../cursorCredentialStore.ts";
import * as ClaudeResetCredits from "./claudeResetCredits.ts";

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const writeLogin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    path.join(directory, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"oauth-token"}}',
  );
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, '{"oauthAccount":{"organizationUuid":"org-1"}}');
  return { configDir: directory, accountConfigPath };
});

const respond = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const refuseRequests = HttpClient.make(() => Effect.die("must not send a request"));
const cedarEmber = {
  cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
};

/** A Keychain stand-in with the production cache, counting how often it is opened. */
const fakeKeychain = (read: () => Promise<string | null>) => {
  let reads = 0;
  const reader = makeCachedKeychainSecretReader(() => {
    reads++;
    return read();
  });
  return { reader, reads: () => reads };
};
const keychainLogin = (accessToken: string, expiresAt = NOW + 3_600_000) =>
  JSON.stringify({
    claudeAiOauth: { accessToken, refreshToken: "refresh", expiresAt, scopes: [] },
  });
const readOnMac = (
  keychain: Partial<ClaudeResetCredits.ClaudeKeychainAccess>,
  client: HttpClient.HttpClient,
  configDir = "/no/credentials/file",
) =>
  TestClock.setTime(NOW).pipe(
    Effect.andThen(
      ClaudeResetCredits.readClaudeResetCredits(
        configDir,
        "2.1.0",
        undefined,
        {},
        {
          enabled: true,
          defaultItem: true,
          ...keychain,
        },
      ),
    ),
    Effect.provideService(HostProcessPlatform, "darwin"),
    Effect.provideService(HttpClient.HttpClient, client),
  );

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 5,
      canRedeem: true,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("counts banked grants without allowing redemption before they are usable", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 1, canRedeem: false });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({
      availableCount: 1,
      canRedeem: false,
    });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
  it("excludes future, expired, malformed, and paused grants but keeps a reset banked for later", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "future",
          grants: [
            grant({
              id: "banked",
              starts_at: "2026-09-22T12:00:00Z",
              ends_at: "2026-10-01T00:00:00Z",
              usable_now: false,
            }),
            grant({ id: "future", starts_at: "2026-09-23T00:00:00Z" }),
            grant({ id: "invalid", starts_at: "2026-02-30T00:00:00Z" }),
            grant({ id: "expired", ends_at: "2026-09-22T12:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "used", resets_left: 0 }),
          ],
        },
        NOW,
      ),
    ).toEqual({ availableCount: 1, canRedeem: false });
  });
});

effectIt.layer(NodeServices.layer)("readClaudeResetCredits", (it) => {
  it.effect("reads the grants with the CLI's request", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(UrlParams.toString(request.urlParams)).toBe("cedar_ember=1&skip_spend=1");
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        expect(request.headers["user-agent"]).toBe("claude-cli/2.1.0 (external, cli)");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
            }),
          ),
        );
      });
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(credits).toEqual({
        credits: { availableCount: 1, canRedeem: true, nextCreditId: "grant_a" },
      });
    }),
  );

  it.effect("reads the login from the Keychain on macOS once turned on", () =>
    Effect.gen(function* () {
      const keychain = fakeKeychain(async () => keychainLogin("keychain-token"));
      const client = HttpClient.make((request) => {
        expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(request.headers.authorization).toBe("Bearer keychain-token");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(cedarEmber)));
      });
      expect(yield* readOnMac({ read: keychain.reader }, client)).toEqual({
        credits: { availableCount: 1, canRedeem: true, nextCreditId: "grant_a" },
      });
      // Later probes reuse the login instead of opening the Keychain again.
      yield* readOnMac({ read: keychain.reader }, client);
      expect(keychain.reads()).toBe(1);
    }),
  );

  it.effect("explains an unreadable Keychain login instead of failing", () =>
    Effect.gen(function* () {
      const cases = [
        [
          async () => Promise.reject(new Error("User interaction is not allowed.")),
          "could not read",
        ],
        [async () => null, "No Claude login"],
        [async () => "not json", "could not read"],
        [async () => JSON.stringify({ claudeAiOauth: {} }), "No Claude login"],
        [async () => keychainLogin("expired", NOW - 1), "expired"],
      ] as const;
      for (const [read, reason] of cases) {
        const result = yield* readOnMac({ read: fakeKeychain(read).reader }, refuseRequests);
        expect(result.credits).toBeUndefined();
        expect(result.unavailableReason).toContain(reason);
      }
    }),
  );

  it.effect("gives up on a Keychain prompt nobody answers after 30 seconds", () =>
    Effect.gen(function* () {
      let opened!: () => void;
      const reading = new Promise<void>((resolve) => (opened = resolve));
      const keychain = fakeKeychain(() => {
        opened();
        return new Promise<never>(() => {});
      });
      const probe = yield* readOnMac({ read: keychain.reader }, refuseRequests).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => reading);
      yield* TestClock.adjust("31 seconds");
      expect(yield* Fiber.join(probe)).toEqual({
        unavailableReason: "ViewCode could not read Claude's login from the Keychain.",
      });
    }),
  );

  it.effect("re-reads the Keychain once after Claude refuses the token", () =>
    Effect.gen(function* () {
      const keychain = fakeKeychain(async () => keychainLogin("revoked"));
      for (let attempt = 0; attempt < 3; attempt++) {
        expect(yield* readOnMac({ read: keychain.reader }, respond(401, {}))).toEqual({});
      }
      // One re-read for the refused token, then no more prompts for the same item.
      expect(keychain.reads()).toBe(2);
    }),
  );

  it.effect("never opens the Keychain while the setting is off or the item is unknown", () =>
    Effect.gen(function* () {
      const keychain = fakeKeychain(async () => keychainLogin("keychain-token"));
      const off = yield* readOnMac({ enabled: false, read: keychain.reader }, refuseRequests);
      const custom = yield* readOnMac(
        { defaultItem: false, read: keychain.reader },
        refuseRequests,
      );
      expect(keychain.reads()).toBe(0);
      expect(off.unavailableReason).toContain("Turn on Claude account usage");
      expect(custom.unavailableReason).toContain("default config directory");
    }),
  );

  it.effect("keeps reading the credentials file on Linux even with the setting on", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const keychain = fakeKeychain(async () => keychainLogin("keychain-token"));
      const client = HttpClient.make((request) => {
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        return Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(cedarEmber)));
      });
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(
        configDir,
        "2.1.0",
        undefined,
        {},
        { enabled: true, defaultItem: true, read: keychain.reader },
      ).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(credits.credits?.availableCount).toBe(1);
      expect(keychain.reads()).toBe(0);
    }),
  );

  it.effect("does not read local Desktop cache for an instance with another HOME", () =>
    ClaudeResetCredits.readClaudeResetCredits(
      "/instance/claude",
      "2.1.283",
      "/local/.claude.json",
      { HOME: "/different-instance-home" },
    ).pipe(
      Effect.provideService(HostProcessPlatform, "darwin"),
      Effect.provideService(
        FileSystem.FileSystem,
        FileSystem.makeNoop({
          readFileString: () => Effect.die("must not read another HOME's account"),
        }),
      ),
      Effect.provideService(HttpClient.HttpClient, refuseRequests),
      Effect.tap((reading) => Effect.sync(() => expect(reading.credits).toBeUndefined())),
    ),
  );

  it.effect("reads nothing from keychain logins or failed requests", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const darwin = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcessPlatform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(429, {})),
      );
      expect(darwin.credits).toBeUndefined();
      expect(darwin.unavailableReason).toContain("Turn on Claude account usage");
      expect(limited).toEqual({});
    }),
  );
});

const ClaimBody = Schema.fromJsonString(
  Schema.Struct({ program: Schema.String, grant_id: Schema.String, request_id: Schema.String }),
);
const decodeClaimBody = Schema.decodeEffect(ClaimBody);

const consume = (client: HttpClient.HttpClient, ids = { grantId: "grant_a", requestId: "r-1" }) =>
  Effect.gen(function* () {
    const login = yield* writeLogin;
    return yield* ClaudeResetCredits.consumeClaudeResetCredit({
      ...login,
      version: "2.1.0",
      ...ids,
    }).pipe(
      Effect.provideService(HostProcessPlatform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
  });

effectIt.layer(NodeServices.layer)("consumeClaudeResetCredit", (it) => {
  it.effect("claims the grant for the organization", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.method).toBe("POST");
          expect(request.url).toBe(
            "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
          );
          expect(request.headers.authorization).toBe("Bearer oauth-token");
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          expect(yield* decodeClaimBody(body)).toEqual({
            program: "cedar_ember",
            grant_id: "grant_a",
            request_id: "r-1",
          });
          return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        }).pipe(Effect.orDie),
      );
      expect(yield* consume(client)).toMatchObject({ _tag: "Success", success: "reset" });
    }),
  );

  it.effect("claims with the Keychain login on macOS once turned on", () =>
    Effect.gen(function* () {
      const login = yield* writeLogin;
      const keychain = fakeKeychain(async () => keychainLogin("keychain-token"));
      const client = HttpClient.make((request) => {
        expect(request.headers.authorization).toBe("Bearer keychain-token");
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({ result: "reset" })),
        );
      });
      const claim = (enabled: boolean) =>
        ClaudeResetCredits.consumeClaudeResetCredit({
          ...login,
          version: "2.1.0",
          grantId: "grant_a",
          requestId: "r-1",
          environment: {},
          keychain: { enabled, defaultItem: true, read: keychain.reader },
        }).pipe(
          Effect.provideService(HostProcessPlatform, "darwin"),
          Effect.provideService(HttpClient.HttpClient, client),
          Effect.result,
        );
      yield* TestClock.setTime(NOW);
      expect(yield* claim(true)).toMatchObject({ _tag: "Success", success: "reset" });
      expect(yield* claim(false)).toMatchObject({
        _tag: "Failure",
        failure: { reason: "signedOut" },
      });
    }),
  );

  it.effect("maps each answer to an outcome or a failure", () =>
    Effect.gen(function* () {
      for (const [result, outcome] of [
        ["not_limited", "nothingToReset"],
        ["already_used", "alreadyRedeemed"],
        ["ineligible", "noCredit"],
      ] as const) {
        expect(yield* consume(respond(200, { result }))).toMatchObject({ success: outcome });
      }
      for (const client of [
        respond(200, { result: "cooldown" }),
        respond(429, {}),
        respond(401, {}),
      ]) {
        const result = yield* consume(client);
        expect(result).toMatchObject({ _tag: "Failure" });
        // Claude answered, so a retry must be a new claim.
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      // No answer, or Claude could not confirm the claim: a retry is the same claim.
      for (const client of [respond(500, {}), respond(200, { result: "unavailable" })]) {
        const unanswered = yield* consume(client);
        expect(unanswered).toMatchObject({ _tag: "Failure" });
        if (unanswered._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(unanswered.failure)).toBe(
            false,
          );
        }
      }
    }),
  );

  it.effect("times out a stalled claim body", () =>
    Effect.gen(function* () {
      const login = yield* writeLogin;
      const readingBody = yield* Deferred.make<void>();
      const client = HttpClient.make((request) => {
        const response = HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        Object.defineProperty(response, "json", {
          value: Deferred.succeed(readingBody, undefined).pipe(Effect.andThen(Effect.never)),
        });
        return Effect.succeed(response);
      });
      const claim = yield* ClaudeResetCredits.consumeClaudeResetCredit({
        ...login,
        version: "2.1.0",
        grantId: "grant_a",
        requestId: "r-1",
      }).pipe(
        Effect.provideService(HostProcessPlatform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
        Effect.result,
        Effect.forkChild,
      );
      yield* Deferred.await(readingBody);
      yield* TestClock.adjust("26 seconds");
      expect(yield* Fiber.join(claim)).toMatchObject({
        _tag: "Failure",
        failure: {
          _tag: "ClaudeResetCreditError",
          reason: "requestFailed",
          cause: { _tag: "TimeoutError" },
        },
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("refuses malformed ids without sending anything", () =>
    Effect.gen(function* () {
      for (const ids of [
        { grantId: "Bad Grant", requestId: "r-1" },
        { grantId: "grant_a", requestId: "has space" },
      ]) {
        expect(yield* consume(refuseRequests, ids)).toMatchObject({ _tag: "Failure" });
      }
    }),
  );
});
