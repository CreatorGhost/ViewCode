import * as NodeNet from "node:net";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as NetService from "./Net.ts";

const closeServer = (server: NodeNet.Server) =>
  Effect.sync(() => {
    try {
      server.close();
    } catch {}
  });

const getPort = (server: NodeNet.Server): number => {
  const address = server.address();
  return typeof address === "object" && address !== null ? address.port : 0;
};

const openServer = (host?: string): Effect.Effect<NodeNet.Server, NetService.NetError> =>
  Effect.callback<NodeNet.Server, NetService.NetError>((resume) => {
    const server = NodeNet.createServer();
    let settled = false;

    const settle = (effect: Effect.Effect<NodeNet.Server, NetService.NetError>) => {
      if (settled) return;
      settled = true;
      resume(effect);
    };

    server.once("error", (cause) => {
      settle(
        Effect.fail(new NetService.NetError({ message: "Failed to open test server", cause })),
      );
    });

    if (host) {
      server.listen(0, host, () => settle(Effect.succeed(server)));
    } else {
      server.listen(0, () => settle(Effect.succeed(server)));
    }

    return closeServer(server);
  });

it.layer(NetService.layer)("NetService (ViewCode)", (it) => {
  it.effect("findAvailablePort moves to the next free port when the preferred one is busy", () =>
    Effect.acquireUseRelease(
      openServer("127.0.0.1"),
      (server) =>
        Effect.gen(function* () {
          const net = yield* NetService.NetService;
          const preferred = getPort(server);
          const nextFree = yield* net.isPortAvailableOnLoopback(preferred + 1);

          const resolved = yield* net.findAvailablePort(preferred);
          assert.notEqual(resolved, preferred);
          if (nextFree) assert.equal(resolved, preferred + 1);
        }),
      closeServer,
    ),
  );
});
