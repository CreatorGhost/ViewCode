import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { RelayMobileClientId } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// The shared connection runtime still asks for a relay client. ViewCode has no
// hosted relay, so an empty URL makes it the disabled variant that fails every call.
const disabledRelaySignerLayer = Layer.succeed(
  ManagedRelay.ManagedRelayDpopSigner,
  ManagedRelay.ManagedRelayDpopSigner.of({
    thumbprint: Effect.fail(
      new ManagedRelay.ManagedRelayDpopKeyLoadError({
        keyStore: "expo-secure-store",
        cause: "relay disabled",
      }),
    ),
    createProof: (input) =>
      Effect.fail(
        new ManagedRelay.ManagedRelayDpopProofCreationError({
          method: input.method,
          url: input.url,
          cause: "relay disabled",
        }),
      ),
  }),
);
export const disabledRelayClientLayer = ManagedRelay.layer({
  relayUrl: "",
  clientId: RelayMobileClientId,
}).pipe(Layer.provideMerge(disabledRelaySignerLayer));
