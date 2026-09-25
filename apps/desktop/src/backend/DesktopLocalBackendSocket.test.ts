// @effect-diagnostics nodeBuiltinImport:off - drives the transport against real Unix sockets.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { afterEach } from "vite-plus/test";

import {
  forwardRequestToSocket,
  localBackendHttpBaseUrl,
  makeSocketHttpClient,
  openSocketTunnel,
  toSocketRequestOptions,
} from "./DesktopLocalBackendSocket.ts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

interface Seen {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const startBackend = async (
  respond: (request: Seen, response: NodeHttp.ServerResponse) => void = (_request, response) =>
    response.end("ok"),
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-socket-"));
  const socketPath = NodePath.join(directory, "backend.sock");
  const seen: Seen[] = [];
  const server = NodeHttp.createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      const entry = {
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body,
      };
      seen.push(entry);
      respond(entry, response);
    });
  });
  const sockets = new NodeWS.WebSocketServer({ server });
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  return { socketPath, seen, sockets };
};

describe("local backend socket transport", () => {
  it("addresses an instance by host on the backend scheme", () => {
    assert.equal(localBackendHttpBaseUrl("primary").href, "t3code-backend://primary/");
  });

  it("forwards the path, query, and renderer headers but not hop-by-hop headers", () => {
    const options = toSocketRequestOptions(
      {
        url: "t3code-backend://primary/api/assets/a%20b.png?sig=1",
        method: "GET",
        headers: new Headers({
          origin: "t3code://app",
          authorization: "Bearer token",
          connection: "keep-alive",
          host: "primary",
          "content-length": "0",
          range: "bytes=0-9",
        }),
      },
      "/tmp/backend.sock",
    );
    assert.deepEqual(options, {
      socketPath: "/tmp/backend.sock",
      method: "GET",
      path: "/api/assets/a%20b.png?sig=1",
      headers: {
        origin: "t3code://app",
        authorization: "Bearer token",
        range: "bytes=0-9",
        host: "localhost",
      },
    });
  });

  it.effect("streams requests and responses through the socket", () =>
    Effect.promise(async () => {
      const { socketPath, seen } = await startBackend((request, response) => {
        if (request.url === "/empty") {
          response.writeHead(204, { "access-control-allow-origin": "*" });
          response.end();
          return;
        }
        response.setHeader("set-cookie", ["a=1", "b=2"]);
        response.writeHead(201, { "content-type": "application/json" });
        response.end(JSON.stringify({ echoed: request.body }));
      });

      const posted = await forwardRequestToSocket(
        new Request("http://placeholder/api/thing?x=1", {
          method: "POST",
          body: "payload",
          headers: { "content-type": "text/plain" },
        }),
        socketPath,
      );
      assert.equal(posted.status, 201);
      assert.deepEqual(await posted.json(), { echoed: "payload" });
      assert.deepEqual(posted.headers.getSetCookie(), ["a=1", "b=2"]);
      assert.equal(seen[0]?.url, "/api/thing?x=1");
      assert.equal(seen[0]?.headers.host, "localhost");

      const empty = await forwardRequestToSocket(
        new Request("http://placeholder/empty"),
        socketPath,
      );
      assert.equal(empty.status, 204);
      assert.equal(empty.body, null);
      assert.equal(empty.headers.get("access-control-allow-origin"), "*");
    }),
  );

  it.effect("gives main-process code an HttpClient that ignores the scheme and host", () =>
    Effect.gen(function* () {
      const { socketPath, seen } = yield* Effect.promise(() => startBackend());
      const client = yield* makeSocketHttpClient(socketPath);
      const response = yield* client.get("t3code-backend://primary/.well-known/t3/environment");
      assert.equal(response.status, 200);
      assert.equal(yield* response.text, "ok");
      assert.equal(seen[0]?.url, "/.well-known/t3/environment");
    }).pipe(Effect.scoped),
  );

  it.effect("tunnels WebSocket frames both ways and propagates close", () =>
    Effect.promise(async () => {
      const { socketPath, sockets } = await startBackend();
      const serverSide = new Promise<{ socket: NodeWS.WebSocket; url: string }>((resolve) =>
        sockets.once("connection", (socket, request) =>
          resolve({ socket, url: request.url ?? "" }),
        ),
      );

      // Stands in for Electron's MessagePortMain.
      const port = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
        postMessage: (message: unknown) => void;
        start: () => void;
        close: () => void;
      };
      const received: Array<Record<string, unknown>> = [];
      const next = () =>
        new Promise<Record<string, unknown>>((resolve) => port.once("posted", resolve));
      port.postMessage = (message) => {
        received.push(message as Record<string, unknown>);
        port.emit("posted", message);
      };
      port.start = () => undefined;
      port.close = () => undefined;

      const opened = next();
      openSocketTunnel({
        url: "t3code-backend://primary/ws?wsToken=abc",
        protocols: [],
        socketPath,
        port,
      });
      assert.deepEqual(await opened, { type: "open", protocol: "", extensions: "" });
      const { socket, url } = await serverSide;
      assert.equal(url, "/ws?wsToken=abc");

      const text = next();
      socket.send("hello");
      assert.deepEqual(await text, { type: "message", data: "hello" });

      const binary = next();
      socket.send(Buffer.from([1, 2, 3]));
      const binaryMessage = await binary;
      assert.instanceOf(binaryMessage.data, ArrayBuffer);
      assert.deepEqual([...new Uint8Array(binaryMessage.data as ArrayBuffer)], [1, 2, 3]);

      const fromRenderer = new Promise<string>((resolve) =>
        socket.once("message", (data) => resolve(data.toString())),
      );
      port.emit("message", { data: { type: "send", data: "from renderer" } });
      assert.equal(await fromRenderer, "from renderer");

      const closed = next();
      port.emit("message", { data: { type: "close", code: 1000, reason: "bye" } });
      assert.deepEqual(await closed, { type: "close", code: 1000, reason: "bye", wasClean: true });
    }),
  );

  it.effect("reports a dead socket as an error followed by an abnormal close", () =>
    Effect.promise(async () => {
      const port = new NodeEvents.EventEmitter() as NodeEvents.EventEmitter & {
        postMessage: (message: unknown) => void;
        start: () => void;
        close: () => void;
      };
      const received: Array<Record<string, unknown>> = [];
      const closed = new Promise<void>((resolve) => {
        port.postMessage = (message) => {
          received.push(message as Record<string, unknown>);
          if ((message as { type: string }).type === "close") resolve();
        };
      });
      port.start = () => undefined;
      port.close = () => undefined;
      openSocketTunnel({
        url: "t3code-backend://primary/ws",
        protocols: [],
        socketPath: NodePath.join(NodeOS.tmpdir(), `t3-missing-${process.pid}.sock`),
        port,
      });
      await closed;
      assert.deepEqual(
        received.map((message) => message.type),
        ["error", "close"],
      );
      assert.equal(received[1]?.code, 1006);
      assert.equal(received[1]?.wasClean, false);
    }),
  );
});
