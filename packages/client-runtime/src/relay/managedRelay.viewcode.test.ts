import { describe, expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ManagedRelay from "./managedRelay.ts";
import * as RpcHttp from "../rpc/http.ts";

// ViewCode guard (005a375fc): linking an environment can create a Cloudflare tunnel, which
// takes several requests, so it gets the server's two-minute provisioning budget instead of
// the ten seconds ordinary relay reads get.

const stalled = (() => new Promise<Response>(() => undefined)) satisfies typeof globalThis.fetch;
const layer = ManagedRelay.layer({
  relayUrl: "https://relay.example.test",
  clientId: "t3-mobile",
}).pipe(
  Layer.provide(
    Layer.succeed(
      ManagedRelay.ManagedRelayDpopSigner,
      ManagedRelay.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("client-thumbprint"),
        createProof: (input) => Effect.succeed(`proof:${input.url}`),
      }),
    ),
  ),
  Layer.provide(RpcHttp.layerRemoteHttpClient(stalled)),
);

describe("ManagedRelayClient tunnel provisioning (ViewCode)", () => {
  it.effect("gives environment linking two minutes, not the ordinary request timeout", () =>
    Effect.gen(function* () {
      const relayClient = yield* ManagedRelay.ManagedRelayClient;
      const errorFiber = yield* relayClient
        .linkEnvironment({
          clerkToken: "clerk-token",
          payload: {
            proof: "proof",
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
        })
        .pipe(Effect.flip, Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.minutes(2));
      expect(yield* Fiber.join(errorFiber)).toMatchObject({
        _tag: "ManagedRelayRequestTimeoutError",
        activity: "Relay environment linking",
        timeoutMs: 120_000,
      });
    }).pipe(Effect.provide(Layer.merge(TestClock.layer(), layer))),
  );
});
