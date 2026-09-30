// @effect-diagnostics nodeBuiltinImport:off - Streaming HTTP and Unix-socket requests need node:http; Effect's client has no socketPath or upgrade-free streaming equivalent.
/**
 * ViewCode Quick connect: serves the frames the relay Worker sends against
 * this server's own HTTP and WebSocket handling. The server is reached where
 * it listens: a TCP port, or the Unix socket of the desktop's no-port mode.
 * No route is added and no auth is bypassed; a forwarded request is an
 * ordinary request that arrives by another road, and ViewCode's pairing and
 * session checks decide what it may do.
 *
 * Plain callbacks rather than Effect: this is a byte pump between two
 * streaming APIs, and the connector wraps it.
 */
import * as NodeHttp from "node:http";

import * as Undici from "@effect/platform-node/Undici";
import {
  chunkBody,
  CreditGate,
  decodeCredit,
  decodeFrame,
  decodeWsMessage,
  encodeCredit,
  encodeWsMessage,
  forwardableHeaders,
  FrameType,
  makeFrame,
  makeJsonFrame,
  openPayload,
  parseRequestHead,
  parseWsClose,
  parseWsOpen,
  type HeaderPairs,
} from "@t3tools/shared/viewcodeRelayProtocol";

import type { LocalTarget } from "./viewCodeRelayHealth.ts";

/** Durable Object sockets carry at most 1 MiB per message; frames add a header. */
const MAX_WS_MESSAGE_BYTES = 1024 * 1024 - 64;
/** Client messages that arrive before the local WebSocket opens wait here. */
const MAX_PENDING_WS_BYTES = 4 * 1024 * 1024;

export interface RelayForwarder {
  /** One binary message from the relay. */
  readonly receive: (data: Uint8Array) => void;
  /** The relay connection is gone: end every stream. */
  readonly closeAll: () => void;
}

interface HttpStream {
  readonly kind: "http";
  readonly request: NodeHttp.ClientRequest;
  /** Response bytes in flight to the relay. */
  readonly window: CreditGate;
}
interface WsStream {
  readonly kind: "ws";
  readonly socket: InstanceType<typeof Undici.WebSocket>;
  readonly pending: Array<string | Uint8Array>;
  pendingBytes: number;
  open: boolean;
}

function toNodeHeaders(pairs: HeaderPairs): NodeHttp.OutgoingHttpHeaders {
  const headers: Record<string, string | string[]> = {};
  for (const [name, value] of pairs) {
    const existing = headers[name];
    if (existing === undefined) headers[name] = value;
    else if (Array.isArray(existing)) existing.push(value);
    else headers[name] = [existing, value];
  }
  return headers;
}

function pairsFromRaw(rawHeaders: ReadonlyArray<string>): HeaderPairs {
  const pairs: Array<readonly [string, string]> = [];
  for (let index = 0; index + 1 < rawHeaders.length; index += 2) {
    pairs.push([rawHeaders[index]!, rawHeaders[index + 1]!]);
  }
  return forwardableHeaders(pairs);
}

/** `Host` as the client addressed the relay, so origin-derived logic sees the public name. */
function hostHeaderFor(pairs: HeaderPairs): string {
  return pairs.find(([name]) => name === "x-forwarded-host")?.[1] ?? "localhost";
}

const validCloseCode = (code: number): boolean => code === 1000 || (code >= 3000 && code <= 4999);

export function createRelayForwarder(options: {
  readonly target: LocalTarget;
  /** Sends one binary message to the relay. */
  readonly send: (message: Uint8Array) => void;
}): RelayForwarder {
  const { target, send } = options;
  const streams = new Map<number, HttpStream | WsStream>();
  const socketAgent =
    target.kind === "socket"
      ? new Undici.Agent({ connect: { socketPath: target.path } })
      : undefined;

  const abort = (streamId: number, reason: string) => {
    send(makeJsonFrame(FrameType.Abort, streamId, { reason }));
    endStream(streamId);
  };

  const endStream = (streamId: number) => {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    if (stream.kind === "http") {
      stream.window.close(new Error("ended"));
      stream.request.destroy();
    } else {
      try {
        stream.socket.close();
      } catch {
        // Already closed.
      }
    }
  };

  const startHttp = (streamId: number, payload: Uint8Array) => {
    const head = parseRequestHead(payload);
    if (!head) return abort(streamId, "Malformed request head.");
    const window = new CreditGate();
    let request: NodeHttp.ClientRequest;
    try {
      request = NodeHttp.request({
        ...(target.kind === "socket"
          ? { socketPath: target.path }
          : { host: target.host, port: target.port }),
        method: head.method,
        path: head.path,
        headers: { ...toNodeHeaders(head.headers), host: hostHeaderFor(head.headers) },
        agent: false,
      });
    } catch {
      return abort(streamId, "Invalid request.");
    }
    streams.set(streamId, { kind: "http", request, window });
    request.on("error", () => {
      if (streams.has(streamId)) abort(streamId, "The local server did not answer.");
    });
    request.on("response", (response) => {
      if (!streams.has(streamId)) {
        response.destroy();
        return;
      }
      send(
        makeJsonFrame(FrameType.ResponseHead, streamId, {
          status: response.statusCode ?? 502,
          headers: pairsFromRaw(response.rawHeaders),
        }),
      );
      void (async () => {
        try {
          for await (const chunk of response) {
            for (const part of chunkBody(chunk as Uint8Array)) {
              await window.acquire(part.byteLength);
              if (!streams.has(streamId)) return;
              send(makeFrame(FrameType.ResponseBody, streamId, part));
            }
          }
          if (!streams.has(streamId)) return;
          send(makeFrame(FrameType.ResponseEnd, streamId));
          streams.delete(streamId);
        } catch {
          if (streams.has(streamId)) abort(streamId, "The response was cut off.");
        }
      })();
    });
    if (!head.hasBody) request.end();
  };

  const startWebSocket = (streamId: number, payload: Uint8Array) => {
    const open = parseWsOpen(payload);
    if (!open) return abort(streamId, "Malformed WebSocket open.");
    const url =
      target.kind === "socket"
        ? `ws://localhost${open.path}`
        : `ws://${target.host.includes(":") ? `[${target.host}]` : target.host}:${target.port}${open.path}`;
    let socket: InstanceType<typeof Undici.WebSocket>;
    try {
      socket = new Undici.WebSocket(url, {
        protocols: [...open.protocols],
        headers: Object.fromEntries(open.headers),
        ...(socketAgent ? { dispatcher: socketAgent } : {}),
      });
    } catch {
      return abort(streamId, "Invalid WebSocket request.");
    }
    socket.binaryType = "arraybuffer";
    const stream: WsStream = { kind: "ws", socket, pending: [], pendingBytes: 0, open: false };
    streams.set(streamId, stream);
    socket.addEventListener("open", () => {
      stream.open = true;
      send(
        makeJsonFrame(
          FrameType.WsAccept,
          streamId,
          socket.protocol ? { protocol: socket.protocol } : {},
        ),
      );
      for (const message of stream.pending.splice(0)) socket.send(message);
      stream.pendingBytes = 0;
    });
    socket.addEventListener("message", (event) => {
      if (!streams.has(streamId)) return;
      const data =
        typeof event.data === "string"
          ? new TextEncoder().encode(event.data)
          : new Uint8Array(event.data as ArrayBuffer);
      if (data.byteLength > MAX_WS_MESSAGE_BYTES) {
        send(makeJsonFrame(FrameType.WsClose, streamId, { code: 1009, reason: "Message too big" }));
        endStream(streamId);
        return;
      }
      send(
        makeFrame(
          FrameType.WsMessage,
          streamId,
          encodeWsMessage(typeof event.data === "string" ? "text" : "binary", data),
        ),
      );
    });
    socket.addEventListener("close", (event) => {
      if (!streams.delete(streamId)) return;
      send(makeJsonFrame(FrameType.WsClose, streamId, { code: event.code, reason: event.reason }));
    });
    socket.addEventListener("error", () => {
      if (streams.has(streamId)) abort(streamId, "The local WebSocket failed.");
    });
  };

  const receive = (data: Uint8Array) => {
    const frame = decodeFrame(data);
    if (!frame) return;
    // Sealing is reserved for a future client; a sealed frame cannot be opened here.
    const payload = openPayload(frame);
    if (payload === null) return;
    const { streamId } = frame;
    const stream = streams.get(streamId);
    switch (frame.type) {
      case FrameType.RequestHead:
        if (!streams.has(streamId)) startHttp(streamId, payload);
        return;
      case FrameType.RequestBody:
        if (stream?.kind !== "http") return;
        stream.request.write(payload, (error) => {
          if (!error && streams.has(streamId)) {
            send(makeFrame(FrameType.Credit, streamId, encodeCredit(payload.byteLength)));
          }
        });
        return;
      case FrameType.RequestEnd:
        if (stream?.kind === "http") stream.request.end();
        return;
      case FrameType.Credit: {
        const credit = decodeCredit(payload);
        if (stream?.kind === "http" && credit !== null) stream.window.release(credit);
        return;
      }
      case FrameType.Abort:
        endStream(streamId);
        return;
      case FrameType.WsOpen:
        if (!streams.has(streamId)) startWebSocket(streamId, payload);
        return;
      case FrameType.WsMessage: {
        if (stream?.kind !== "ws") return;
        const message = decodeWsMessage(payload);
        if (!message) return;
        const value =
          message.kind === "text" ? new TextDecoder().decode(message.data) : message.data;
        if (stream.open) {
          stream.socket.send(value);
          return;
        }
        stream.pendingBytes += message.data.byteLength;
        if (stream.pendingBytes > MAX_PENDING_WS_BYTES) {
          abort(streamId, "Too much data before the connection opened.");
          return;
        }
        stream.pending.push(value);
        return;
      }
      case FrameType.WsClose: {
        if (stream?.kind !== "ws") return;
        const close = parseWsClose(payload);
        streams.delete(streamId);
        try {
          if (close && validCloseCode(close.code))
            stream.socket.close(close.code, close.reason.slice(0, 120));
          else stream.socket.close();
        } catch {
          // Already closed.
        }
        return;
      }
      default:
        return;
    }
  };

  return {
    receive,
    closeAll: () => {
      // Ending a stream removes it from the map; deleting during iteration is safe.
      for (const streamId of streams.keys()) endStream(streamId);
      void socketAgent?.close().catch(() => undefined);
    },
  };
}
