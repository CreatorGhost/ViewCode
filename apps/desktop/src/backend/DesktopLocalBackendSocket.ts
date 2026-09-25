// @effect-diagnostics nodeBuiltinImport:off - forwards Chromium requests to a Unix socket or named pipe, which only node:http can dial.
/**
 * Carries traffic to a desktop-local backend that listens on a Unix
 * socket or named pipe instead of a TCP port.
 *
 * The renderer addresses such a backend as `t3code-backend://<instance id>/`.
 * HTTP on that scheme is served by `protocol.handle`, which forwards each
 * request over the socket and streams the response back. Chromium cannot
 * upgrade a custom-scheme request to a WebSocket, so the preload opens those
 * through an IPC `MessagePort`, and main dials the backend with `ws`.
 *
 * Main-process callers (readiness probe, bearer bootstrap) use
 * `makeSocketHttpClient`, which sends any request URL over the socket.
 */
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeStream from "node:stream";

import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as NodeHttpClient from "@effect/platform-node/NodeHttpClient";
import * as Undici from "@effect/platform-node/Undici";
import { DESKTOP_LOCAL_BACKEND_SCHEME } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

/** The base URL the renderer uses for a socket-backed local instance. */
export const localBackendHttpBaseUrl = (instanceId: string): URL =>
  new URL(`${DESKTOP_LOCAL_BACKEND_SCHEME}://${instanceId}/`);

// Hop-by-hop headers, plus those node:http derives itself for the socket hop.
const REQUEST_HEADERS_DROPPED = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "content-length",
]);

/**
 * The node:http request that carries `request` to the backend at
 * `socketPath`. The backend sees a plain `localhost` request; Origin and the
 * rest of the renderer's headers pass through for CORS and auth.
 */
export function toSocketRequestOptions(
  request: { readonly url: string; readonly method: string; readonly headers: Headers },
  socketPath: string,
): NodeHttp.RequestOptions {
  const url = new URL(request.url);
  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    if (!REQUEST_HEADERS_DROPPED.has(name.toLowerCase())) headers[name] = value;
  });
  headers.host = "localhost";
  return {
    socketPath,
    method: request.method,
    path: `${url.pathname || "/"}${url.search}`,
    headers,
  };
}

const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/** Converts the backend's reply into the Response `protocol.handle` returns. */
export function toProtocolResponse(response: NodeHttp.IncomingMessage, method: string): Response {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (value === undefined || name === "connection" || name === "transfer-encoding") continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(name, entry);
  }
  const status = response.statusCode ?? 502;
  const hasBody = method !== "HEAD" && !NULL_BODY_STATUSES.has(status);
  if (!hasBody) response.resume();
  return new Response(
    hasBody ? (NodeStream.Readable.toWeb(response) as ReadableStream<Uint8Array>) : null,
    { status, statusText: response.statusMessage ?? "", headers },
  );
}

/** Forwards one `protocol.handle` request to the backend's socket. */
export function forwardRequestToSocket(request: Request, socketPath: string): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const outgoing = NodeHttp.request(toSocketRequestOptions(request, socketPath), (response) =>
      resolve(toProtocolResponse(response, request.method)),
    );
    outgoing.on("error", reject);
    if (request.body === null || request.method === "GET" || request.method === "HEAD") {
      outgoing.end();
      return;
    }
    NodeStream.Readable.fromWeb(request.body as import("node:stream/web").ReadableStream)
      .on("error", (error) => outgoing.destroy(error))
      .pipe(outgoing);
  });
}

/**
 * An HttpClient that sends every request over `socketPath`, keeping only the
 * URL's path and query. Main-process code can then keep using the backend's
 * `t3code-backend:` base URL, which no network stack could resolve: an undici
 * pool dials its own origin and ignores the one each request names.
 */
export const makeSocketHttpClient = Effect.fn("desktop.localBackend.makeSocketHttpClient")(
  function* (socketPath: string) {
    const dispatcher = yield* Effect.acquireRelease(
      Effect.sync(() => new Undici.Pool("http://localhost", { connect: { socketPath } })),
      (pool) => Effect.promise(() => pool.close()),
    );
    return yield* NodeHttpClient.makeUndici.pipe(
      Effect.provideService(NodeHttpClient.Dispatcher, dispatcher),
    );
  },
);

/** Runs `effect` with an HttpClient bound to `socketPath` when one is given. */
export const withBackendHttpClient =
  (socketPath: string | undefined) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    socketPath === undefined
      ? effect
      : Effect.scoped(
          Effect.flatMap(makeSocketHttpClient(socketPath), (client) =>
            Effect.provideService(effect, HttpClient.HttpClient, client),
          ),
        );

/** What the renderer sends over a socket tunnel port. */
type TunnelInbound =
  | { readonly type: "send"; readonly data: string | ArrayBuffer | Uint8Array }
  | { readonly type: "close"; readonly code?: number; readonly reason?: string };

interface TunnelPort {
  postMessage(message: unknown): void;
  on(event: "message", listener: (event: { readonly data: unknown }) => void): unknown;
  on(event: "close", listener: () => void): unknown;
  start(): void;
  close(): void;
}

const isValidCloseCode = (code: number) => code === 1000 || (code >= 3000 && code <= 4999);

const toArrayBuffer = (data: NodeWS.RawData): ArrayBuffer => {
  const buffer = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as ArrayBuffer);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
};

/**
 * Bridges one renderer WebSocket to the backend at `socketPath`. Frames the
 * renderer posts to `port` go to the backend; backend frames, open, error,
 * and close come back as messages the preload turns into WebSocket events.
 */
export function openSocketTunnel(input: {
  readonly url: string;
  readonly protocols: ReadonlyArray<string>;
  readonly socketPath: string;
  readonly port: TunnelPort;
}): void {
  const url = new URL(input.url);
  const socket = new NodeWS.WebSocket(
    `ws://localhost${url.pathname || "/"}${url.search}`,
    [...input.protocols],
    {
      perMessageDeflate: true,
      // `ws` ignores a `socketPath` option; dial the socket or pipe ourselves.
      createConnection: () => NodeNet.connect(input.socketPath),
    },
  );
  socket.binaryType = "nodebuffer";
  let closed = false;

  input.port.on("message", ({ data }) => {
    const message = data as TunnelInbound;
    if (message.type === "send") {
      if (socket.readyState === NodeWS.WebSocket.OPEN) socket.send(message.data);
    } else if (message.type === "close") {
      const code =
        message.code !== undefined && isValidCloseCode(message.code) ? message.code : 1000;
      if (socket.readyState === NodeWS.WebSocket.CONNECTING) socket.terminate();
      else socket.close(code, message.reason);
    }
  });
  // The renderer reloaded or closed the page.
  input.port.on("close", () => {
    if (!closed) socket.terminate();
  });
  input.port.start();

  socket.on("open", () => {
    input.port.postMessage({
      type: "open",
      protocol: socket.protocol,
      extensions: socket.extensions,
    });
  });
  socket.on("message", (data, isBinary) => {
    input.port.postMessage({
      type: "message",
      data: isBinary ? toArrayBuffer(data) : Buffer.from(toArrayBuffer(data)).toString("utf8"),
    });
  });
  socket.on("error", (error) => {
    input.port.postMessage({ type: "error", message: error.message });
  });
  socket.on("close", (code, reason) => {
    closed = true;
    input.port.postMessage({
      type: "close",
      code,
      reason: reason.toString("utf8"),
      wasClean: code !== 1006,
    });
    input.port.close();
  });
}
