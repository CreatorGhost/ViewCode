import { describe, expect, it } from "@effect/vitest";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { EnvironmentId } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
} from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import { disabledRelayClientLayer } from "../../lib/viewcodeManagedRelay";

describe("ViewCode mobile managed relay", () => {
  it.effect("denies hosted relay operations without sending credentials or provisioning", () => {
    let requestCount = 0;
    const fetch: typeof globalThis.fetch = () => {
      requestCount += 1;
      return Promise.reject(new Error("Disabled relay must not make requests."));
    };
    return Effect.gen(function* () {
      const client = yield* ManagedRelay.ManagedRelayClient;
      const clerkToken = "private-cloud-session";
      const environmentId = EnvironmentId.make("environment");
      const operations = [
        client.listEnvironments({ clerkToken }),
        client.getEnvironmentStatus({
          clerkToken,
          environmentId,
          scopes: [RelayEnvironmentStatusScope],
        }),
        client.connectEnvironment({
          clerkToken,
          environmentId,
          scopes: [RelayEnvironmentConnectScope],
        }),
        client.createEnvironmentLinkChallenge({
          clerkToken,
          payload: {
            notificationsEnabled: false,
            liveActivitiesEnabled: false,
            managedTunnelsEnabled: false,
          },
        }),
      ];
      for (const operation of operations) {
        const error = yield* Effect.flip(operation);
        expect(error).toMatchObject({ _tag: "ManagedRelayUrlInvalidError", relayUrl: "" });
        expect(JSON.stringify(error)).not.toContain(clerkToken);
        expect(String(error)).not.toContain(clerkToken);
      }
      yield* client.resetTokenCache;
      expect(requestCount).toBe(0);
    }).pipe(
      Effect.provide(
        disabledRelayClientLayer.pipe(
          Layer.provide(
            FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
          ),
        ),
      ),
    );
  });

  it.effect("keeps repeated proof-key attempts disabled and does not expose a private token", () =>
    Effect.gen(function* () {
      const signer = yield* ManagedRelay.ManagedRelayDpopSigner;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const error = yield* Effect.flip(signer.thumbprint);
        expect(error).toMatchObject({
          _tag: "ManagedRelayDpopKeyLoadError",
          keyStore: "expo-secure-store",
          cause: "relay disabled",
        });
      }
      const accessToken = "private-dpop-access-token";
      const proofError = yield* Effect.flip(
        signer.createProof({
          method: "POST",
          url: "https://relay.example.test/connect",
          accessToken,
        }),
      );
      expect(proofError).toMatchObject({
        _tag: "ManagedRelayDpopProofCreationError",
        cause: "relay disabled",
      });
      expect(String(proofError)).not.toContain(accessToken);
      expect(JSON.stringify(proofError)).not.toContain(accessToken);
    }).pipe(Effect.provide(disabledRelayClientLayer.pipe(Layer.provide(FetchHttpClient.layer)))),
  );
});
