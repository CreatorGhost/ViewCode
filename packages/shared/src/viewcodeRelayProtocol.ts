/**
 * ViewCode Quick connect: the frame protocol spoken over the one WebSocket a
 * ViewCode server holds open to its own relay Worker (`infra/viewcode-relay`).
 * The Worker and the server import this same module, so the two ends cannot
 * drift apart.
 *
 * Many client requests share that socket. Every frame names a stream:
 *
 *   byte 0      frame type
 *   byte 1      flags (bit 0: payload is sealed, see `FrameSealer`)
 *   bytes 2-5   stream id, unsigned big endian
 *   bytes 6..   payload
 *
 * Head, accept, close and abort payloads are UTF-8 JSON. Body chunks and
 * WebSocket messages are raw bytes. Durable Object WebSocket messages are
 * limited to 1 MiB, so a body is cut into chunks of at most
 * `MAX_BODY_CHUNK_BYTES`; the header and JSON heads stay far below the limit.
 *
 * Confidentiality: nothing here encrypts. The relay is a Worker on the user's
 * own Cloudflare account and sees the traffic it forwards, like the network's
 * TLS inspection does. The `sealed` flag and `FrameSealer` exist so a future
 * ViewCode-aware client can add a per-client encryption layer without a
 * protocol change; the stock T3 Code phone app cannot, so nothing uses it yet.
 */

export const RELAY_HOST_PATH = "/__viewcode/host";

/**
 * The host secret's name in the server's secret store (`<secrets>/<name>.bin`).
 * `scripts/viewcode-relay.ts` writes it; the connector reads it. It is never
 * put in settings, logs or the UI.
 */
export const RELAY_HOST_SECRET_NAME = "viewcode-relay-host-secret";

/** Body chunks stay well under the 1 MiB Durable Object WebSocket message limit. */
export const MAX_BODY_CHUNK_BYTES = 256 * 1024;

/**
 * Unacknowledged body bytes one stream may have in flight in one direction.
 * The receiver returns `Credit` frames as its consumer drains the data.
 */
export const STREAM_WINDOW_BYTES = 1024 * 1024;

/** The host pings this often; the Worker answers without waking (auto response). */
export const HOST_PING_INTERVAL_MS = 20_000;
/** Pings in a row without a pong before the host gives the socket up for dead. */
export const HOST_MAX_MISSED_PONGS = 2;
export const HOST_PING_TEXT = "__viewcode_ping__";
export const HOST_PONG_TEXT = "__viewcode_pong__";

export const FrameType = {
  /** Worker to host: method, path, headers. */
  RequestHead: 0x10,
  RequestBody: 0x11,
  RequestEnd: 0x12,
  /** Host to Worker. */
  ResponseHead: 0x20,
  ResponseBody: 0x21,
  ResponseEnd: 0x22,
  /** Either direction: the stream is dead, drop it. */
  Abort: 0x30,
  /** Worker to host: a client wants a WebSocket. */
  WsOpen: 0x40,
  /** Host to Worker: the local server accepted it. */
  WsAccept: 0x41,
  /** Either direction. First payload byte: 0 text, 1 binary. */
  WsMessage: 0x42,
  WsClose: 0x43,
  /** The receiver consumed this many body bytes; payload is a u32. */
  Credit: 0x50,
} as const;
export type FrameType = (typeof FrameType)[keyof typeof FrameType];

const FRAME_TYPES: ReadonlySet<number> = new Set(Object.values(FrameType));
export const FRAME_HEADER_BYTES = 6;
export const FLAG_SEALED = 0b1;
export const MAX_STREAM_ID = 0xffff_ffff;

export interface Frame {
  readonly type: FrameType;
  readonly streamId: number;
  readonly sealed: boolean;
  readonly payload: Uint8Array;
}

export type HeaderPairs = ReadonlyArray<readonly [string, string]>;

export interface RequestHead {
  readonly method: string;
  /** Path and query, exactly as the client sent them. */
  readonly path: string;
  readonly headers: HeaderPairs;
  /** False when the request has no body, so `RequestEnd` follows immediately. */
  readonly hasBody: boolean;
}
export interface ResponseHead {
  readonly status: number;
  readonly headers: HeaderPairs;
}
export interface WsOpen {
  readonly path: string;
  readonly headers: HeaderPairs;
  readonly protocols: ReadonlyArray<string>;
}
export interface WsAccept {
  readonly protocol?: string;
}
export interface WsClose {
  readonly code: number;
  readonly reason: string;
}
export interface Abort {
  readonly reason?: string;
}

export interface FrameSealer {
  readonly seal: (plain: Uint8Array) => Uint8Array;
  /** Returns null when the payload does not authenticate. */
  readonly open: (sealed: Uint8Array) => Uint8Array | null;
}

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function encodeFrame(frame: Frame): Uint8Array {
  if (!Number.isInteger(frame.streamId) || frame.streamId < 0 || frame.streamId > MAX_STREAM_ID) {
    throw new RangeError(`Invalid stream id ${frame.streamId}`);
  }
  const out = new Uint8Array(FRAME_HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer);
  out[0] = frame.type;
  out[1] = frame.sealed ? FLAG_SEALED : 0;
  view.setUint32(2, frame.streamId);
  out.set(frame.payload, FRAME_HEADER_BYTES);
  return out;
}

/** Null for anything that is not a frame this version understands. */
export function decodeFrame(data: Uint8Array): Frame | null {
  if (data.byteLength < FRAME_HEADER_BYTES) return null;
  const type = data[0];
  const flags = data[1];
  if (type === undefined || flags === undefined || !FRAME_TYPES.has(type)) return null;
  if ((flags & ~FLAG_SEALED) !== 0) return null;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    type: type as FrameType,
    streamId: view.getUint32(2),
    sealed: (flags & FLAG_SEALED) !== 0,
    payload: data.subarray(FRAME_HEADER_BYTES),
  };
}

export function makeFrame(
  type: FrameType,
  streamId: number,
  payload: Uint8Array = new Uint8Array(0),
  sealer?: FrameSealer,
): Uint8Array {
  return encodeFrame({
    type,
    streamId,
    sealed: sealer !== undefined,
    payload: sealer ? sealer.seal(payload) : payload,
  });
}

export function makeJsonFrame(
  type: FrameType,
  streamId: number,
  value: unknown,
  sealer?: FrameSealer,
): Uint8Array {
  return makeFrame(type, streamId, textEncoder.encode(JSON.stringify(value)), sealer);
}

/** The payload with any sealing removed; null when it is sealed and no sealer opens it. */
export function openPayload(frame: Frame, sealer?: FrameSealer): Uint8Array | null {
  if (!frame.sealed) return sealer ? null : frame.payload;
  return sealer ? sealer.open(frame.payload) : null;
}

/** Null when the payload is not valid JSON; callers validate the shape they need. */
export function parseJsonPayload(payload: Uint8Array): unknown {
  try {
    return JSON.parse(textDecoder.decode(payload));
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isHeaderPairs = (value: unknown): value is HeaderPairs =>
  Array.isArray(value) &&
  value.every(
    (pair) =>
      Array.isArray(pair) &&
      pair.length === 2 &&
      typeof pair[0] === "string" &&
      typeof pair[1] === "string",
  );

export function parseRequestHead(payload: Uint8Array): RequestHead | null {
  const value = parseJsonPayload(payload);
  if (
    !isRecord(value) ||
    typeof value.method !== "string" ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    !isHeaderPairs(value.headers) ||
    typeof value.hasBody !== "boolean"
  ) {
    return null;
  }
  return {
    method: value.method,
    path: value.path,
    headers: value.headers,
    hasBody: value.hasBody,
  };
}

export function parseResponseHead(payload: Uint8Array): ResponseHead | null {
  const value = parseJsonPayload(payload);
  if (
    !isRecord(value) ||
    typeof value.status !== "number" ||
    !Number.isInteger(value.status) ||
    value.status < 100 ||
    value.status > 599 ||
    !isHeaderPairs(value.headers)
  ) {
    return null;
  }
  return { status: value.status, headers: value.headers };
}

export function parseWsOpen(payload: Uint8Array): WsOpen | null {
  const value = parseJsonPayload(payload);
  if (
    !isRecord(value) ||
    typeof value.path !== "string" ||
    !value.path.startsWith("/") ||
    !isHeaderPairs(value.headers) ||
    !Array.isArray(value.protocols) ||
    !value.protocols.every((entry) => typeof entry === "string")
  ) {
    return null;
  }
  return { path: value.path, headers: value.headers, protocols: value.protocols as string[] };
}

export function parseWsAccept(payload: Uint8Array): WsAccept | null {
  const value = parseJsonPayload(payload);
  if (!isRecord(value)) return null;
  return typeof value.protocol === "string" ? { protocol: value.protocol } : {};
}

export function parseWsClose(payload: Uint8Array): WsClose | null {
  const value = parseJsonPayload(payload);
  if (!isRecord(value) || typeof value.code !== "number" || typeof value.reason !== "string") {
    return null;
  }
  return { code: value.code, reason: value.reason };
}

export function parseAbort(payload: Uint8Array): Abort {
  const value = parseJsonPayload(payload);
  return isRecord(value) && typeof value.reason === "string" ? { reason: value.reason } : {};
}

export function encodeCredit(bytes: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, Math.min(Math.max(0, Math.floor(bytes)), 0xffff_ffff));
  return out;
}

export function decodeCredit(payload: Uint8Array): number | null {
  if (payload.byteLength !== 4) return null;
  return new DataView(payload.buffer, payload.byteOffset, 4).getUint32(0);
}

export type WsMessageKind = "text" | "binary";

export function encodeWsMessage(kind: WsMessageKind, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(1 + data.byteLength);
  out[0] = kind === "text" ? 0 : 1;
  out.set(data, 1);
  return out;
}

export function decodeWsMessage(
  payload: Uint8Array,
): { readonly kind: WsMessageKind; readonly data: Uint8Array } | null {
  const kind = payload[0];
  if (kind !== 0 && kind !== 1) return null;
  return { kind: kind === 0 ? "text" : "binary", data: payload.subarray(1) };
}

/** Cuts a body into chunks the socket can carry. Empty input yields nothing. */
export function* chunkBody(
  body: Uint8Array,
  maxChunkBytes: number = MAX_BODY_CHUNK_BYTES,
): Generator<Uint8Array> {
  for (let offset = 0; offset < body.byteLength; offset += maxChunkBytes) {
    yield body.subarray(offset, Math.min(offset + maxChunkBytes, body.byteLength));
  }
}

/**
 * Headers that describe one hop, not the message. Neither end forwards them.
 * `host` is dropped too: each side sets its own, and the original authority
 * travels as `x-forwarded-host`.
 */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "proxy-connection",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
  "sec-websocket-key",
  "sec-websocket-version",
  "sec-websocket-extensions",
  "sec-websocket-accept",
]);

/** Cloudflare adds these; they describe the edge, not the client's request. */
const EDGE_HEADER_PREFIXES = ["cf-", "x-forwarded-", "x-real-ip"];

export function forwardableHeaders(headers: Iterable<readonly [string, string]>): HeaderPairs {
  const out: Array<readonly [string, string]> = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (HOP_BY_HOP.has(lower)) continue;
    if (EDGE_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))) continue;
    out.push([lower, value]);
  }
  return out;
}

/**
 * Tracks bytes in flight for one stream direction. `reserve` says how many of
 * the requested bytes may be sent now; `release` records the receiver's
 * credit. Pure bookkeeping: the caller decides how to wait.
 */
export class CreditWindow {
  #inFlight = 0;
  readonly #limit: number;
  constructor(limit: number = STREAM_WINDOW_BYTES) {
    this.#limit = limit;
  }
  get inFlight(): number {
    return this.#inFlight;
  }
  get available(): number {
    return Math.max(0, this.#limit - this.#inFlight);
  }
  /** Reserves up to `bytes`; returns what was granted (possibly 0). */
  reserve(bytes: number): number {
    const granted = Math.min(bytes, this.available);
    this.#inFlight += granted;
    return granted;
  }
  release(bytes: number): void {
    this.#inFlight = Math.max(0, this.#inFlight - bytes);
  }
}

/** Constant-time comparison of two strings by content, not by where they differ. */
export function timingSafeEqualBytes(left: Uint8Array, right: Uint8Array): boolean {
  let diff = left.byteLength ^ right.byteLength;
  const length = Math.max(left.byteLength, right.byteLength);
  for (let index = 0; index < length; index += 1) {
    diff |= (left[index] ?? 0) ^ (right[index] ?? 0);
  }
  return diff === 0;
}

/**
 * Lets a sender wait for window space. `acquire` resolves once the chunk fits;
 * chunks are served in order so a large chunk is not starved by small ones.
 * `close` fails every waiter, for a stream that ended or was aborted.
 */
export class CreditGate {
  readonly #window: CreditWindow;
  readonly #waiters: Array<{
    readonly bytes: number;
    readonly resolve: () => void;
    readonly reject: (error: Error) => void;
  }> = [];
  #closed: Error | null = null;

  constructor(limit: number = STREAM_WINDOW_BYTES) {
    this.#window = new CreditWindow(limit);
  }

  get inFlight(): number {
    return this.#window.inFlight;
  }

  acquire(bytes: number): Promise<void> {
    if (this.#closed) return Promise.reject(this.#closed);
    if (this.#waiters.length === 0 && this.#window.available >= bytes) {
      this.#window.reserve(bytes);
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      this.#waiters.push({ bytes, resolve, reject });
    });
  }

  release(bytes: number): void {
    this.#window.release(bytes);
    for (let next = this.#waiters[0]; next; next = this.#waiters[0]) {
      if (this.#window.available < next.bytes) break;
      this.#waiters.shift();
      this.#window.reserve(next.bytes);
      next.resolve();
    }
  }

  close(error: Error): void {
    this.#closed = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }
}
