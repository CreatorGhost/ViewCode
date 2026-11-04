/**
 * The session scanner with ViewCode's Cursor and T3 Code readers. server.ts
 * provides `layer`, this one reference, to the v2 importer (runtimeLayer.ts
 * builds no scanner of its own), the MCP tools and each WebSocket connection,
 * so the server's layer build memoizes a single scanner and one import read
 * lock between UI and agent imports. The per-connection `Effect.provide` forks
 * the server's memo map and finds that instance. A bare
 * `AgentSessionScanner.layer` sees no reader and lists only Claude Code and
 * Codex sessions.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import * as CursorHistory from "./CursorHistory.ts";
import * as T3CodeHistory from "./T3CodeHistory.ts";

/** The scanner over readers its composition supplies; tests pass fixture paths here. */
export const layerFromReaders = Layer.effect(
  AgentSessionScanner.AgentSessionScanner,
  Effect.gen(function* () {
    // Required rather than optional so leaving a reader out is a type error here.
    yield* CursorHistory.CursorHistory;
    yield* T3CodeHistory.T3CodeHistory;
    return yield* AgentSessionScanner.make;
  }),
);

export const layer = layerFromReaders.pipe(
  Layer.provide(Layer.merge(CursorHistory.layer, T3CodeHistory.layer)),
);
