/**
 * ViewCode guard: a Mac server reports Cursor usage that waits for the Keychain opt-in with
 * CURSOR_KEYCHAIN_USAGE_OFF_MESSAGE, and only then. The web rail matches that message to show an
 * "off" Cursor ring with an Enable action; any other wording drops Cursor from the rail unexplained.
 */
import { describe, expect, it } from "@effect/vitest";
import { NodeServices } from "@effect/platform-node";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { CURSOR_KEYCHAIN_USAGE_OFF_MESSAGE } from "@t3tools/shared/usageLimits";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as CursorKeychain from "./CursorKeychain.ts";
import { readCursorUsageLimits } from "./usageLimits.ts";

const read = (environment: NodeJS.ProcessEnv) =>
  readCursorUsageLimits({ apiEndpoint: "" }, environment, false).pipe(
    Effect.provideService(HostProcess.Platform, "darwin"),
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("must not request usage")),
    ),
    Effect.provideService(CursorKeychain.CursorKeychain, {
      accessToken: Effect.die("must not read Keychain"),
    }),
    Effect.provide(NodeServices.layer),
  );

describe("Cursor usage off until the Keychain opt-in (ViewCode)", () => {
  it.effect("reports the shared off message for a Mac login that waits for the opt-in", () =>
    Effect.gen(function* () {
      const limits = yield* read({ HOME: "/nonexistent" });
      expect(limits.unavailable?.message).toBe(CURSOR_KEYCHAIN_USAGE_OFF_MESSAGE);
    }),
  );

  it.effect("does not offer the opt-in for an API key, which enabling cannot help", () =>
    Effect.gen(function* () {
      const limits = yield* read({ HOME: "/nonexistent", CURSOR_API_KEY: "key" });
      expect(limits.unavailable?.message).not.toBe(CURSOR_KEYCHAIN_USAGE_OFF_MESSAGE);
    }),
  );
});
