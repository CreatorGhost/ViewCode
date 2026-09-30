// @effect-diagnostics cryptoRandomUUID:off globalDate:off globalTimers:off - Worker code runs on the Workers runtime, outside Effect.
/**
 * The relay's only stateful piece: one Durable Object per deployment that
 * holds the host's WebSocket and multiplexes every phone or browser request
 * over it (frame format in `@t3tools/shared/viewcodeRelayProtocol`).
 *
 * Sockets use the Hibernation API, so an idle relay costs nothing: the host's
 * application ping is answered by an auto-response without waking this class.
 * Per-request state (open streams) lives in memory; it only exists while a
 * request is in flight, which keeps the object awake.
 *
 * The relay never authenticates phones. ViewCode's pairing and session auth
 * runs end to end on the host. Nothing here logs bodies or headers.
 */
import { DurableObject } from "cloudflare:workers";
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
  HOST_PING_TEXT,
  HOST_PONG_TEXT,
  makeFrame,
  makeJsonFrame,
  openPayload,
  parseAbort,
  parseResponseHead,
  parseWsClose,
  RELAY_HOST_PATH,
  type Frame,
  type ResponseHead,
} from "@t3tools/shared/viewcodeRelayProtocol";

import {
  closeEndsHostSession,
  currentHost,
  HOST_DISCONNECTED_MESSAGE,
  isHostAuthorized,
  routeRequest,
  socketsToReplace,
  type HostSocketRecord,
} from "./routing.ts";

export interface Env {
  readonly RELAY: DurableObjectNamespace<RelayDurableObject>;
  /** Worker secret; the host presents it as a bearer token. */
  readonly HOST_SECRET?: string;
}

const HOST_TAG = "host";
/** The platform limit is 1 MiB per WebSocket message; frames add a 6 byte header. */
const MAX_WS_MESSAGE_BYTES = 1024 * 1024 - 64;
const RESPONSE_HEAD_TIMEOUT_MS = 120_000;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

type Attachment =
  | { readonly role: "host"; readonly id: string; readonly connectedAt: number }
  | { readonly role: "client"; readonly streamId: number };

/** One proxied HTTP request: the response head, its body queue and the request-body window. */
class HttpStream {
  readonly requestWindow = new CreditGate();
  readonly head: Promise<ResponseHead>;
  #resolveHead!: (head: ResponseHead) => void;
  #rejectHead!: (error: Error) => void;
  readonly #queue: Uint8Array[] = [];
  #ended = false;
  #failure: Error | null = null;
  #waiter: (() => void) | null = null;

  constructor() {
    this.head = new Promise<ResponseHead>((resolve, reject) => {
      this.#resolveHead = resolve;
      this.#rejectHead = reject;
    });
    // A rejected head with nobody awaiting yet must not surface as unhandled.
    this.head.catch(() => undefined);
  }

  resolveHead(head: ResponseHead): void {
    this.#resolveHead(head);
  }

  push(chunk: Uint8Array): void {
    this.#queue.push(chunk);
    this.#wake();
  }

  end(): void {
    this.#ended = true;
    this.#wake();
  }

  fail(error: Error): void {
    this.#failure ??= error;
    this.#rejectHead(error);
    this.requestWindow.close(error);
    this.#wake();
  }

  /** The next body chunk, or null at the end. Throws if the stream failed. */
  async next(): Promise<Uint8Array | null> {
    for (;;) {
      const chunk = this.#queue.shift();
      if (chunk) return chunk;
      if (this.#failure) throw this.#failure;
      if (this.#ended) return null;
      await new Promise<void>((resolve) => {
        this.#waiter = resolve;
      });
    }
  }

  #wake(): void {
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.();
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  return data instanceof ArrayBuffer
    ? new Uint8Array(data)
    : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

/** WebSocket close codes 1005, 1006 and 1015 must never be sent. */
function sendableCloseCode(code: number): number {
  return code === 1000 ||
    (code >= 1001 && code <= 1014 && code !== 1005 && code !== 1006) ||
    (code >= 3000 && code <= 4999)
    ? code
    : 1000;
}

export class RelayDurableObject extends DurableObject<Env> {
  readonly #streams = new Map<number, HttpStream>();
  #nextStreamId = 1;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(HOST_PING_TEXT, HOST_PONG_TEXT));
    // After hibernation the counter restarts; skip ids held by client sockets that survived.
    for (const socket of ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.role === "client") {
        this.#nextStreamId = Math.max(this.#nextStreamId, attachment.streamId + 1);
      }
    }
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const route = routeRequest({
      pathname: url.pathname,
      upgrade: request.headers.get("upgrade"),
      hostAuthorized:
        url.pathname === RELAY_HOST_PATH &&
        (await isHostAuthorized(request.headers.get("authorization"), this.env.HOST_SECRET)),
    });
    switch (route.kind) {
      case "host-connect":
        return this.#acceptHost();
      case "reject":
        return new Response(route.status === 404 ? "Not Found" : null, {
          status: route.status,
          headers: route.status === 426 ? { upgrade: "websocket" } : {},
        });
      case "proxy":
        return request.headers.get("upgrade")?.toLowerCase() === "websocket"
          ? this.#proxyWebSocket(request, url)
          : this.#proxyHttp(request, url);
    }
  }

  // --- host connection -----------------------------------------------------

  #hostRecords(): Array<HostSocketRecord & { readonly socket: WebSocket }> {
    const records: Array<HostSocketRecord & { readonly socket: WebSocket }> = [];
    for (const socket of this.ctx.getWebSockets(HOST_TAG)) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.role === "host") {
        records.push({ id: attachment.id, connectedAt: attachment.connectedAt, socket });
      }
    }
    return records;
  }

  #host(): WebSocket | null {
    const records = this.#hostRecords();
    const host = currentHost(records);
    return records.find((record) => record.id === host?.id)?.socket ?? null;
  }

  #acceptHost(): Response {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    const id = crypto.randomUUID();
    const previous = this.#hostRecords();
    this.ctx.acceptWebSocket(server, [HOST_TAG]);
    server.serializeAttachment({ role: "host", id, connectedAt: Date.now() } satisfies Attachment);
    if (previous.length > 0) {
      // Streams belong to the old socket; the new host knows nothing of them.
      this.#abortEverything("The host reconnected.");
      const replaced = new Set(socketsToReplace([...previous, { id, connectedAt: 0 }], id));
      for (const record of previous) {
        if (replaced.has(record.id))
          record.socket.close(1012, "Replaced by a newer host connection");
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  #send(socket: WebSocket, frame: Uint8Array): void {
    try {
      socket.send(frame);
    } catch {
      // The socket is closing; its close handler cleans the streams up.
    }
  }

  #abortEverything(reason: string): void {
    for (const stream of this.#streams.values()) stream.fail(new Error(reason));
    this.#streams.clear();
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as Attachment | null;
      if (attachment?.role === "client") {
        try {
          socket.close(1012, reason);
        } catch {
          // Already closed.
        }
      }
    }
  }

  // --- proxied HTTP ----------------------------------------------------------

  #allocateStreamId(): number {
    const id = this.#nextStreamId;
    this.#nextStreamId = id >= 0xffff_fffe ? 1 : id + 1;
    return id;
  }

  #unavailable(): Response {
    return new Response(HOST_DISCONNECTED_MESSAGE, {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "5" },
    });
  }

  async #proxyHttp(request: Request, url: URL): Promise<Response> {
    const host = this.#host();
    if (!host) return this.#unavailable();

    const streamId = this.#allocateStreamId();
    const stream = new HttpStream();
    this.#streams.set(streamId, stream);
    const abort = (reason: string) => {
      this.#send(host, makeJsonFrame(FrameType.Abort, streamId, { reason }));
      stream.fail(new Error(reason));
      this.#streams.delete(streamId);
    };
    request.signal.addEventListener("abort", () => abort("The client went away."), { once: true });

    this.#send(
      host,
      makeJsonFrame(FrameType.RequestHead, streamId, {
        method: request.method,
        path: url.pathname + url.search,
        headers: [
          ...forwardableHeaders(request.headers),
          ["x-forwarded-host", url.host],
          ["x-forwarded-proto", "https"],
        ],
        hasBody: request.body !== null,
      }),
    );
    if (request.body === null) {
      this.#send(host, makeFrame(FrameType.RequestEnd, streamId));
    } else {
      void this.#pumpRequestBody(request.body, host, streamId, stream, abort);
    }

    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const head = await Promise.race([
        stream.head,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The computer did not answer in time.")),
            RESPONSE_HEAD_TIMEOUT_MS,
          );
        }),
      ]);
      const headers = new Headers();
      for (const [name, value] of forwardableHeaders(head.headers)) headers.append(name, value);
      if (NULL_BODY_STATUSES.has(head.status)) {
        this.#streams.delete(streamId);
        return new Response(null, { status: head.status, headers });
      }
      // highWaterMark 0: the host is asked for more only when the client reads, so
      // the credit window (not memory) bounds what is buffered here.
      const body = new ReadableStream<Uint8Array>(
        {
          pull: async (controller) => {
            let chunk: Uint8Array | null;
            try {
              chunk = await stream.next();
            } catch (error) {
              this.#streams.delete(streamId);
              controller.error(error);
              return;
            }
            if (chunk === null) {
              this.#streams.delete(streamId);
              controller.close();
              return;
            }
            controller.enqueue(chunk);
            this.#send(host, makeFrame(FrameType.Credit, streamId, encodeCredit(chunk.byteLength)));
          },
          cancel: () => abort("The client stopped reading."),
        },
        { highWaterMark: 0 },
      );
      return new Response(body, { status: head.status, headers });
    } catch {
      abort("No response from the computer.");
      return new Response("ViewCode on your computer did not respond.", {
        status: 502,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async #pumpRequestBody(
    body: ReadableStream<Uint8Array>,
    host: WebSocket,
    streamId: number,
    stream: HttpStream,
    abort: (reason: string) => void,
  ): Promise<void> {
    const reader = body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const chunk of chunkBody(value)) {
          await stream.requestWindow.acquire(chunk.byteLength);
          this.#send(host, makeFrame(FrameType.RequestBody, streamId, chunk));
        }
      }
      this.#send(host, makeFrame(FrameType.RequestEnd, streamId));
    } catch {
      abort("The request body could not be forwarded.");
    } finally {
      reader.releaseLock();
    }
  }

  // --- proxied WebSockets ------------------------------------------------------

  #proxyWebSocket(request: Request, url: URL): Response {
    const host = this.#host();
    if (!host) return this.#unavailable();
    const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    const streamId = this.#allocateStreamId();
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this.ctx.acceptWebSocket(server, [`stream-${streamId}`]);
    server.serializeAttachment({ role: "client", streamId } satisfies Attachment);
    this.#send(
      host,
      makeJsonFrame(FrameType.WsOpen, streamId, {
        path: url.pathname + url.search,
        headers: [
          ...forwardableHeaders(request.headers).filter(
            ([name]) => name !== "sec-websocket-protocol",
          ),
          ["x-forwarded-host", url.host],
          ["x-forwarded-proto", "https"],
        ],
        protocols,
      }),
    );
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: protocols[0] ? { "sec-websocket-protocol": protocols[0] } : {},
    });
  }

  #clientSocket(streamId: number): WebSocket | null {
    for (const socket of this.ctx.getWebSockets(`stream-${streamId}`)) return socket;
    return null;
  }

  // --- hibernation handlers ------------------------------------------------------

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "host") {
      if (typeof message === "string") return;
      // A replaced socket that has not closed yet must not speak for the host.
      if (currentHost(this.#hostRecords())?.id !== attachment.id) return;
      const frame = decodeFrame(new Uint8Array(message));
      if (frame) this.#onHostFrame(frame);
      return;
    }
    if (attachment?.role !== "client") return;
    const host = this.#host();
    if (!host) {
      ws.close(1012, HOST_DISCONNECTED_MESSAGE);
      return;
    }
    const data = typeof message === "string" ? encoder.encode(message) : toBytes(message);
    if (data.byteLength > MAX_WS_MESSAGE_BYTES) {
      ws.close(1009, "Message too big");
      return;
    }
    this.#send(
      host,
      makeFrame(
        FrameType.WsMessage,
        attachment.streamId,
        encodeWsMessage(typeof message === "string" ? "text" : "binary", data),
      ),
    );
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (attachment?.role === "host") {
      if (closeEndsHostSession(this.#hostRecords(), attachment.id)) {
        this.#abortEverything("The computer disconnected.");
      }
    } else if (attachment?.role === "client") {
      const host = this.#host();
      if (host) {
        this.#send(
          host,
          makeJsonFrame(FrameType.WsClose, attachment.streamId, {
            code: sendableCloseCode(code),
            reason,
          }),
        );
      }
    }
    try {
      ws.close(sendableCloseCode(code), reason);
    } catch {
      // Already closed.
    }
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    await this.webSocketClose(ws, 1011, "error");
  }

  #onHostFrame(frame: Frame): void {
    // This relay does not seal; a sealed frame cannot be opened here.
    const payload = openPayload(frame);
    if (payload === null) return;
    const stream = this.#streams.get(frame.streamId);
    switch (frame.type) {
      case FrameType.ResponseHead: {
        const head = parseResponseHead(payload);
        if (stream && head) stream.resolveHead(head);
        else if (stream) stream.fail(new Error("Invalid response head."));
        return;
      }
      case FrameType.ResponseBody:
        stream?.push(payload);
        return;
      case FrameType.ResponseEnd:
        stream?.end();
        return;
      case FrameType.Credit: {
        const credit = decodeCredit(payload);
        if (stream && credit !== null) stream.requestWindow.release(credit);
        return;
      }
      case FrameType.Abort: {
        const reason = parseAbort(payload).reason ?? "The computer aborted the request.";
        if (stream) {
          stream.fail(new Error(reason));
          this.#streams.delete(frame.streamId);
        } else {
          this.#clientSocket(frame.streamId)?.close(1011, reason.slice(0, 120));
        }
        return;
      }
      case FrameType.WsMessage: {
        const message = decodeWsMessage(payload);
        const socket = this.#clientSocket(frame.streamId);
        if (!message || !socket) return;
        try {
          socket.send(message.kind === "text" ? decoder.decode(message.data) : message.data);
        } catch {
          // The client is closing.
        }
        return;
      }
      case FrameType.WsClose: {
        const close = parseWsClose(payload);
        const socket = this.#clientSocket(frame.streamId);
        if (!socket) return;
        try {
          socket.close(sendableCloseCode(close?.code ?? 1000), (close?.reason ?? "").slice(0, 120));
        } catch {
          // Already closed.
        }
        return;
      }
      default:
        // WsAccept needs no action: the client got its 101 up front.
        return;
    }
  }
}
