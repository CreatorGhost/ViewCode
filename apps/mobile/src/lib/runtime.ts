import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ManagedRuntime from "effect/ManagedRuntime";
import * as Socket from "effect/unstable/socket/Socket";

import { ManagedRelay } from "@t3tools/client-runtime/relay";
import { remoteHttpClientLayer } from "@t3tools/client-runtime/rpc";
import { RelayMobileClientId } from "@t3tools/contracts/relay";

import { tracingLayer } from "../features/observability/tracing";
import * as Persistence from "../persistence/layer";
import { cryptoLayer } from "./cryptoLayer";
import { disposeOnFoundationReplace, type FoundationHotModule } from "./foundation-fast-refresh";

declare const module: { readonly hot?: FoundationHotModule } | undefined;

const httpClientLayer = remoteHttpClientLayer(fetch);

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
const disabledRelayClientLayer = ManagedRelay.layer({
  relayUrl: "",
  clientId: RelayMobileClientId,
}).pipe(Layer.provideMerge(disabledRelaySignerLayer));

type RuntimeLayerSource =
  | typeof disabledRelayClientLayer
  | typeof cryptoLayer
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof httpClientLayer
  | typeof Persistence.layer
  | typeof tracingLayer;

const runtimeLayer = Layer.merge(
  disabledRelayClientLayer,
  Socket.layerWebSocketConstructorGlobal,
).pipe(
  Layer.provideMerge(cryptoLayer),
  Layer.provideMerge(httpClientLayer),
  Layer.provideMerge(tracingLayer.pipe(Layer.provide(httpClientLayer))),
  Layer.provideMerge(Persistence.layer),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);

disposeOnFoundationReplace(typeof module === "undefined" ? undefined : module.hot, () =>
  runtime.dispose(),
);
