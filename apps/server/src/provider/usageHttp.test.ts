import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import { makeUsageHttpReader } from "./usageHttp.ts";

it.effect("honors Retry-After without sharing cooldowns with another account or endpoint", () =>
  Effect.gen(function* () {
    const read = makeUsageHttpReader();
    const calls: string[] = [];
    let status = 429;
    const client = HttpClient.make((request) => {
      calls.push(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, {
            status,
            headers: { "Retry-After": "1800" },
          }),
        ),
      );
    });
    const run = (credential = "account-a", url = "https://usage.example/limits") =>
      read({
        provider: "Example",
        credential,
        request: HttpClientRequest.get(url),
      }).pipe(Effect.flip, Effect.provideService(HttpClient.HttpClient, client));

    expect((yield* run()).kind).toBe("rateLimited");
    yield* run();
    expect(calls).toHaveLength(1);
    yield* run("account-b");
    yield* run("account-a", "https://usage.example/credits");
    expect(calls).toHaveLength(3);
    yield* TestClock.adjust("1799 seconds");
    yield* run();
    expect(calls).toHaveLength(3);
    yield* TestClock.adjust("1 second");
    status = 200;
    const response = yield* read({
      provider: "Example",
      credential: "account-a",
      request: HttpClientRequest.get("https://usage.example/limits"),
    }).pipe(Effect.provideService(HttpClient.HttpClient, client));
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(4);
  }),
);

it.effect("parses HTTP-date Retry-After and resets exponential fallback after success", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(0);
    const read = makeUsageHttpReader();
    let calls = 0;
    let status = 429;
    let retryAfter = "Thu, 01 Jan 1970 00:02:00 GMT";
    const request = HttpClientRequest.get("https://usage.example/limits");
    const client = HttpClient.make(() => {
      calls++;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(null, { status, headers: { "Retry-After": retryAfter } }),
        ),
      );
    });
    const run = read({ provider: "Example", credential: "account", request }).pipe(
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

it.effect("reports sanitized authentication, HTTP, and transport failures", () =>
  Effect.gen(function* () {
    const read = makeUsageHttpReader();
    const request = HttpClientRequest.get("https://usage.example/limits");
    for (const status of [401, 403, 503]) {
      const failure = yield* read({ provider: "Example", credential: "private-key", request }).pipe(
        Effect.flip,
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("private-response", { status })),
            ),
          ),
        ),
      );
      expect(failure.kind).toBe(status === 503 ? "http" : "authentication");
      expect(failure.message).not.toContain("private");
      expect(failure.message).toContain(status === 503 ? "503" : "Sign in");
    }
    const failure = yield* read({ provider: "Example", credential: "private-key", request }).pipe(
      Effect.flip,
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.fail(
            new HttpClientError.HttpClientError({
              reason: new HttpClientError.TransportError({ request, cause: "private-key" }),
            }),
          ),
        ),
      ),
    );
    expect(failure.kind).toBe("network");
    expect(failure.message).toContain("connection");
    expect(failure.message).not.toContain("private-key");
    const allowed = yield* read({
      provider: "Example",
      credential: "private-key",
      request,
      allowedStatuses: [403],
    }).pipe(
      Effect.provideService(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 403 }))),
        ),
      ),
    );
    expect(allowed.status).toBe(403);
  }),
);
