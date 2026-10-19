import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as Connector from "../relay/ViewCodeRelayConnector.ts";
import * as Setup from "../relay/ViewCodeRelaySetup.ts";
import type { LocalTarget } from "../relay/viewCodeRelayHealth.ts";

const make = Effect.gen(function* () {
  const connector = yield* Connector.ViewCodeRelayConnector;
  const setup = yield* Setup.ViewCodeRelaySetup;
  return {
    accessFields: Effect.all({viewcodeRelay:connector.currentState,viewcodeRelaySetup:setup.current}),
    changes: Stream.merge(connector.stateChanges.pipe(Stream.map(() => undefined)), setup.changes.pipe(Stream.map(() => undefined))),
    networkChanged: connector.networkChanged,
    run: (target: LocalTarget) => Effect.all([
      connector.run(target),
      connector.stateChanges.pipe(Stream.runForEach((state) => state.status === "connected" ? setup.relayConnected : Effect.void)),
    ], {concurrency:"unbounded",discard:true}),
  };
});
export class ViewCodeRelayRuntime extends Context.Service<ViewCodeRelayRuntime,Effect.Success<typeof make>>() ("t3/server/viewcodeRelayLayers/ViewCodeRelayRuntime") {}
export const layer = Layer.effect(ViewCodeRelayRuntime,make).pipe(Layer.provideMerge(Layer.merge(Connector.layer,Setup.layer)));
