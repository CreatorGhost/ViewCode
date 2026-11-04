import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeViewCodeGrokBillingReader } from "./viewcodeBilling.ts";

it.effect("honors HTTP-date billing cooldowns and resets fallback after a successful read", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const read = makeViewCodeGrokBillingReader();
    let calls = 0;
    let status = 429;
    let retryAfter = "Thu, 01 Jan 1970 00:02:00 GMT";
    const client = HttpClient.make((request) => {
      calls++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, { status, headers: { "Retry-After": retryAfter } }),
        ),
      );
    });
    const run = read("account").pipe(
      Effect.option,
      Effect.provideService(HttpClient.HttpClient, client),
    );
    yield* run;
    yield* TestClock.adjust("119 seconds");
    yield* run;
    expect(calls).toBe(1);
    yield* TestClock.adjust("1 second");
    retryAfter = "invalid";
    yield* run;
    expect(calls).toBe(2);
    yield* TestClock.adjust("119 seconds");
    yield* run;
    expect(calls).toBe(2);
    yield* TestClock.adjust("1 second");
    status = 200;
    yield* run;
    expect(calls).toBe(3);
    status = 429;
    yield* run;
    yield* TestClock.adjust("60 seconds");
    yield* run;
    expect(calls).toBe(5);
  }),
);

it.effect(
  "keeps auth, HTTP and transport diagnostics separate without exposing private material",
  () =>
    Effect.gen(function* () {
      const read = makeViewCodeGrokBillingReader();
      for (const status of [401, 403, 503]) {
        const failure = yield* read("private-key").pipe(
          Effect.flip,
          Effect.provideService(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.succeed(
                HttpClientResponse.fromWeb(request, new Response("private-response", { status })),
              ),
            ),
          ),
        );
        expect(failure.kind).toBe(status === 503 ? "http" : "authentication");
        expect(failure.status).toBe(status);
        expect(failure.message).not.toContain("private");
        expect(failure.message).toContain(status === 503 ? "503" : "Sign in");
      }
      const failure = yield* read("private-key").pipe(
        Effect.flip,
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.fail(
              new HttpClientError.HttpClientError({
                reason: new HttpClientError.TransportError({ request, cause: "private-key" }),
              }),
            ),
          ),
        ),
      );
      expect(failure.kind).toBe("network");
      expect(failure.message).toBe(
        "Grok usage could not be reached. Check your connection and try again.",
      );
      expect(failure.message).not.toContain("private-key");
      expect(failure.cause).toBeInstanceOf(HttpClientError.HttpClientError);
    }),
);
