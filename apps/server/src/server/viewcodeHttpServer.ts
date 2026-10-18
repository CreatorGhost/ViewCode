// @effect-diagnostics nodeBuiltinImport:off - The HTTP adapter constructs the native Node server.
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import { guardHttpResponseWriteErrors } from "../httpResponseErrorGuard.ts";
import {
  ListenPathUnavailableError,
  prepareListenPath,
  restrictListenPathPermissions,
} from "../socketListener.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const listenPath = config.listenPath;
    if (listenPath !== undefined) yield* prepareListenPath(listenPath);
    return NodeHttpServer.layer(() => guardHttpResponseWriteErrors(NodeHttp.createServer()), {
      ...(listenPath === undefined
        ? { host: config.host ?? "127.0.0.1", port: config.port }
        : { path: listenPath }),
      // WebSocket RPC scopes already close their sockets gracefully.
      gracefulShutdownTimeout: 0,
      // Keep upstream's shared compression window for small streaming frames.
      websocket: { perMessageDeflate: true },
    }).pipe(
      // Layer dependencies finish before routes are served. A chmod failure
      // closes the listener through NodeHttpServer's scoped finalizer.
      Layer.tap(() =>
        listenPath === undefined
          ? Effect.void
          : Effect.try({
              try: () => restrictListenPathPermissions(listenPath),
              catch: () =>
                new ListenPathUnavailableError({
                  listenPath,
                  reason: "could not restrict socket permissions to its owner",
                }),
            }),
      ),
    );
  }),
);
