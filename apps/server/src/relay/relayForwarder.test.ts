// @effect-diagnostics nodeBuiltinImport:off - The fake local server is plain node:http.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import * as NodeZlib from "node:zlib";

import {
  chunkBody,
  decodeFrame,
  decodeWsMessage,
  encodeCredit,
  encodeWsMessage,
  type Frame,
  FrameType,
  makeFrame,
  makeJsonFrame,
  MAX_BODY_CHUNK_BYTES,
  parseResponseHead,
  parseWsAccept,
  parseWsClose,
  STREAM_WINDOW_BYTES,
} from "@t3tools/shared/viewcodeRelayProtocol";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createRelayForwarder,
  type OversizedRelayMessage,
  type RelayForwarder,
} from "./relayForwarder.ts";
import type { LocalTarget } from "./viewCodeRelayHealth.ts";

/** The relay's end of the socket: records what the host sends and lets a test wait for a frame. */
function makeRelayEnd() {
  const frames: Frame[] = [];
  const waiters: Array<{
    readonly test: (frame: Frame) => boolean;
    readonly resolve: (frame: Frame) => void;
  }> = [];
  const onFrame = (data: Uint8Array) => {
    const frame = decodeFrame(data)!;
    frames.push(frame);
    for (const waiter of waiters.slice()) {
      if (waiter.test(frame)) {
        waiters.splice(waiters.indexOf(waiter), 1);
        waiter.resolve(frame);
      }
    }
  };
  /** The next unconsumed frame of this type on this stream, already recorded or still to come. */
  const next = (type: number, streamId: number) => {
    const test = (frame: Frame) => frame.type === type && frame.streamId === streamId;
    const seen = frames.find(test);
    if (seen) {
      frames.splice(frames.indexOf(seen), 1);
      return Promise.resolve(seen);
    }
    return new Promise<Frame>((resolve) => {
      waiters.push({
        test,
        resolve: (frame) => {
          frames.splice(frames.indexOf(frame), 1);
          resolve(frame);
        },
      });
    });
  };
  return { frames, onFrame, next };
}

const closers: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of closers.splice(0)) await close();
});

const listen = (server: NodeHttp.Server, where: number | string) =>
  new Promise<void>((resolve) => {
    if (typeof where === "number") server.listen(where, "127.0.0.1", resolve);
    else server.listen(where, resolve);
  });

async function startLocal(
  mode: "tcp" | "socket",
  handler: NodeHttp.RequestListener,
): Promise<{ server: NodeHttp.Server; target: LocalTarget }> {
  const server = NodeHttp.createServer(handler);
  // Upgraded sockets leave the server's own bookkeeping, so track them to end them.
  const upgraded = new Set<NodeStream.Duplex>();
  server.on("upgrade", (_request, socket: NodeStream.Duplex) => upgraded.add(socket));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
        for (const socket of upgraded) socket.destroy();
      }),
  );
  if (mode === "tcp") {
    await listen(server, 0);
    const address = server.address();
    if (typeof address !== "object" || address === null) throw new Error("no address");
    return { server, target: { kind: "tcp", host: "127.0.0.1", port: address.port } };
  }
  const path = NodePath.join(
    NodeOS.tmpdir(),
    `vc-relay-${process.pid}-${NodeCrypto.randomBytes(3).toString("hex")}.sock`,
  );
  await listen(server, path);
  closers.push(() => NodeFS.rmSync(path, { force: true }));
  return { server, target: { kind: "socket", path } };
}

function connect(
  target: LocalTarget,
  onOversizedMessage?: (details: OversizedRelayMessage) => void,
) {
  const relay = makeRelayEnd();
  const forwarder: RelayForwarder = createRelayForwarder({
    target,
    send: relay.onFrame,
    onOversizedMessage: onOversizedMessage ?? (() => {}),
  });
  closers.push(() => forwarder.closeAll());
  return { relay, forwarder };
}

const requestHead = (
  method: string,
  path: string,
  headers: Array<[string, string]> = [],
  hasBody = false,
) => makeJsonFrame(FrameType.RequestHead, 1, { method, path, headers, hasBody });

describe.each(["tcp", "socket"] as const)("relay forwarder over %s", (mode) => {
  it("logs the RPC tag and closes an oversized WebSocket message with 1009", async () => {
    const { server, target } = await startLocal(mode, () => undefined);
    server.on("upgrade", (request, socket: NodeStream.Duplex) => {
      const accept = NodeCrypto.createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      const message = Buffer.from(
        `{"tag":"subscribeServerConfig","payload":{"secret":"DO_NOT_LOG","padding":"${"x".repeat(1024 * 1024)}"}}`,
      );
      const header = Buffer.alloc(10);
      header[0] = 0x81;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(message.byteLength), 2);
      socket.write(Buffer.concat([header, message]));
    });
    const warnings: OversizedRelayMessage[] = [];
    const { relay, forwarder } = connect(target, (details) => warnings.push(details));
    forwarder.receive(
      makeJsonFrame(FrameType.WsOpen, 9, { path: "/ws", headers: [], protocols: [] }),
    );

    const close = parseWsClose((await relay.next(FrameType.WsClose, 9)).payload);
    expect(close?.code).toBe(1009);
    expect(warnings).toEqual([
      {
        byteLength: expect.any(Number),
        streamId: 9,
        messagePrefix: '{"tag":"subscribeServerConfig"}',
      },
    ]);
    expect(warnings[0]?.byteLength).toBeGreaterThan(1024 * 1024);
    expect(JSON.stringify(warnings)).not.toContain("DO_NOT_LOG");
  });

  it("serves a GET, keeps duplicate headers, and presents the public host", async () => {
    let seenHost: string | undefined;
    let seenAuth: string | undefined;
    const { target } = await startLocal(mode, (request, response) => {
      seenHost = request.headers.host;
      seenAuth = request.headers.authorization;
      response.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": ["a=1; Path=/", "b=2; Path=/"],
      });
      response.end('{"ok":true}');
    });
    const { relay, forwarder } = connect(target);

    forwarder.receive(
      requestHead("GET", "/.well-known/t3/environment?x=1", [
        ["authorization", "Bearer t"],
        ["x-forwarded-host", "relay.example.workers.dev"],
      ]),
    );
    const head = parseResponseHead((await relay.next(FrameType.ResponseHead, 1)).payload);
    expect(head?.status).toBe(200);
    expect(head?.headers.filter(([name]) => name.toLowerCase() === "set-cookie")).toHaveLength(2);
    expect(new TextDecoder().decode((await relay.next(FrameType.ResponseBody, 1)).payload)).toBe(
      '{"ok":true}',
    );
    await relay.next(FrameType.ResponseEnd, 1);
    expect(seenHost).toBe("relay.example.workers.dev");
    expect(seenAuth).toBe("Bearer t");
  });

  it("streams a request body in chunks and returns a credit for each", async () => {
    let received = Buffer.alloc(0);
    const { target } = await startLocal(mode, (request, response) => {
      const parts: Buffer[] = [];
      request.on("data", (part: Buffer) => parts.push(part));
      request.on("end", () => {
        received = Buffer.concat(parts);
        response.writeHead(201).end();
      });
    });
    const { relay, forwarder } = connect(target);
    const body = new Uint8Array(MAX_BODY_CHUNK_BYTES + 5).map((_, index) => index % 253);

    forwarder.receive(requestHead("POST", "/api/upload", [], true));
    for (const chunk of chunkBody(body))
      forwarder.receive(makeFrame(FrameType.RequestBody, 1, chunk));
    forwarder.receive(makeFrame(FrameType.RequestEnd, 1));

    expect(parseResponseHead((await relay.next(FrameType.ResponseHead, 1)).payload)?.status).toBe(
      201,
    );
    expect(Uint8Array.from(received)).toEqual(body);
    const credits = relay.frames.filter((frame) => frame.type === FrameType.Credit);
    expect(
      credits.reduce(
        (sum, frame) =>
          sum + new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint32(0),
        0,
      ),
    ).toBe(body.byteLength);
  });

  it("never has more than a window of response bytes in flight", async () => {
    const total = STREAM_WINDOW_BYTES * 3;
    const { target } = await startLocal(mode, (_request, response) => {
      response.writeHead(200);
      response.end(Buffer.alloc(total, 7));
    });
    const { relay, forwarder } = connect(target);
    forwarder.receive(requestHead("GET", "/big"));
    await relay.next(FrameType.ResponseHead, 1);

    let delivered = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let credited = 0;
    while (delivered < total) {
      const chunk = await relay.next(FrameType.ResponseBody, 1);
      expect(chunk.payload.byteLength).toBeLessThanOrEqual(MAX_BODY_CHUNK_BYTES);
      delivered += chunk.payload.byteLength;
      inFlight += chunk.payload.byteLength;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // A slow reader acknowledges in batches, well before the window is exhausted.
      if (inFlight >= STREAM_WINDOW_BYTES / 2) {
        forwarder.receive(makeFrame(FrameType.Credit, 1, encodeCredit(inFlight)));
        credited += inFlight;
        inFlight = 0;
      }
    }
    await relay.next(FrameType.ResponseEnd, 1);
    expect(delivered).toBe(total);
    expect(credited).toBeGreaterThan(0);
    expect(maxInFlight).toBeLessThanOrEqual(STREAM_WINDOW_BYTES);
  });

  it("aborts the stream when the local server cannot be reached", async () => {
    const { server, target } = await startLocal(mode, () => undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    const { relay, forwarder } = connect(target);
    forwarder.receive(requestHead("GET", "/pair"));
    expect((await relay.next(FrameType.Abort, 1)).type).toBe(FrameType.Abort);
  });

  it("destroys the local request when the relay aborts it", async () => {
    let closed!: () => void;
    const localClosed = new Promise<void>((resolve) => (closed = resolve));
    const started = Promise.withResolvers<void>();
    const { target } = await startLocal(mode, (request) => {
      request.on("close", closed);
      started.resolve();
    });
    const { forwarder } = connect(target);
    forwarder.receive(requestHead("POST", "/hang", [], true));
    forwarder.receive(makeFrame(FrameType.RequestBody, 1, Uint8Array.of(1)));
    await started.promise;
    forwarder.receive(makeJsonFrame(FrameType.Abort, 1, { reason: "gone" }));
    await localClosed;
  });

  it("proxies a WebSocket both ways, including messages sent before it opened", async () => {
    const seen = { origin: undefined as string | undefined, closeCode: 0 };
    const closedByClient = Promise.withResolvers<void>();
    const { server, target } = await startLocal(mode, () => undefined);
    server.on("upgrade", (request, socket: NodeStream.Duplex) => {
      seen.origin = request.headers.origin;
      const accept = NodeCrypto.createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      socket.on("data", (buffer: Buffer) => {
        const opcode = buffer[0]! & 0x0f;
        const length = buffer[1]! & 0x7f;
        const mask = buffer.subarray(2, 6);
        const payload = Buffer.from(
          buffer.subarray(6, 6 + length).map((byte, index) => byte ^ mask[index % 4]!),
        );
        if (opcode === 8) {
          seen.closeCode = payload.readUInt16BE(0);
          socket.end(Buffer.from([0x88, 0]));
          closedByClient.resolve();
          return;
        }
        socket.write(Buffer.concat([Buffer.from([0x80 | opcode, length]), payload]));
      });
    });
    const { relay, forwarder } = connect(target);

    forwarder.receive(
      makeJsonFrame(FrameType.WsOpen, 9, {
        path: "/ws",
        headers: [["origin", "https://relay.example.workers.dev"]],
        protocols: [],
      }),
    );
    // Sent immediately, before the local socket is open.
    forwarder.receive(
      makeFrame(FrameType.WsMessage, 9, encodeWsMessage("text", new TextEncoder().encode("early"))),
    );
    expect(parseWsAccept((await relay.next(FrameType.WsAccept, 9)).payload)).toEqual({});
    const early = decodeWsMessage((await relay.next(FrameType.WsMessage, 9)).payload);
    expect(early?.kind).toBe("text");
    expect(new TextDecoder().decode(early?.data)).toBe("early");

    forwarder.receive(
      makeFrame(FrameType.WsMessage, 9, encodeWsMessage("binary", Uint8Array.of(1, 2, 3))),
    );
    const echoed = decodeWsMessage((await relay.next(FrameType.WsMessage, 9)).payload);
    expect(echoed?.kind).toBe("binary");
    expect([...(echoed?.data ?? [])]).toEqual([1, 2, 3]);

    forwarder.receive(makeJsonFrame(FrameType.WsClose, 9, { code: 1000, reason: "bye" }));
    await closedByClient.promise;
    expect(seen.closeCode).toBe(1000);
    expect(seen.origin).toBe("https://relay.example.workers.dev");
    // The local socket's own close is not echoed back after the relay closed first.
    expect(relay.frames.some((frame) => frame.type === FrameType.WsClose)).toBe(false);
  });

  it("requests identity from the local server so the edge owns compression", async () => {
    // A page the app would serve. The fake server compresses it exactly as the
    // real one would: brotli when the request asks for br, gzip for gzip, plain
    // otherwise. If the forwarder ever stopped forcing identity, the origin
    // would hand back a compressed, content-encoding-labelled body, the
    // Cloudflare edge would relabel it for the phone, and the phone would fail
    // to decode it. Forcing identity keeps declared and actual bytes in sync.
    const html =
      "<!doctype html><html><head><title>ViewCode</title></head>" +
      '<body><script src="/app.js"></script>Hello from ViewCode</body></html>';
    const seenAcceptEncoding: Array<string | undefined> = [];
    const { target } = await startLocal(mode, (request, response) => {
      const acceptEncoding = request.headers["accept-encoding"];
      seenAcceptEncoding.push(
        Array.isArray(acceptEncoding) ? acceptEncoding.join(", ") : acceptEncoding,
      );
      const asked = (
        Array.isArray(acceptEncoding) ? acceptEncoding.join(",") : (acceptEncoding ?? "")
      ).toLowerCase();
      const raw = Buffer.from(html, "utf8");
      if (/\bbr\b/u.test(asked)) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "br",
        });
        response.end(NodeZlib.brotliCompressSync(raw));
      } else if (/\bgzip\b/u.test(asked)) {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "content-encoding": "gzip",
        });
        response.end(NodeZlib.gzipSync(raw));
      } else {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end(raw);
      }
    });
    const { relay, forwarder } = connect(target);

    const collect = async (streamId: number) => {
      const head = parseResponseHead((await relay.next(FrameType.ResponseHead, streamId)).payload);
      await relay.next(FrameType.ResponseEnd, streamId);
      const body = Buffer.concat(
        relay.frames
          .filter((frame) => frame.type === FrameType.ResponseBody && frame.streamId === streamId)
          .map((frame) => Buffer.from(frame.payload)),
      );
      return { head, body };
    };
    /** Decode using the encoding the response declares, as a real client would. */
    const decodeByHeader = (
      head: ReturnType<typeof parseResponseHead>,
      body: Buffer,
    ): { readonly encoding: string; readonly text: string } => {
      const encoding =
        head?.headers
          .find(([name]) => name.toLowerCase() === "content-encoding")?.[1]
          ?.toLowerCase() ?? "identity";
      const decoded =
        encoding === "br"
          ? NodeZlib.brotliDecompressSync(body)
          : encoding === "gzip"
            ? NodeZlib.gunzipSync(body)
            : body;
      return { encoding, text: decoded.toString("utf8") };
    };

    // gzip, br, zstd, identity, and a client that sends no Accept-Encoding.
    const clientEncodings: Array<string | null> = ["gzip", "br", "zstd", "identity", null];
    for (const [index, clientEncoding] of clientEncodings.entries()) {
      const streamId = 100 + index;
      const headers: Array<[string, string]> =
        clientEncoding === null ? [] : [["accept-encoding", clientEncoding]];
      forwarder.receive(
        makeJsonFrame(FrameType.RequestHead, streamId, {
          method: "GET",
          path: "/",
          headers,
          hasBody: false,
        }),
      );
      const { head, body } = await collect(streamId);
      // The local server was asked for identity no matter what the client wanted.
      expect(seenAcceptEncoding[index]).toBe("identity");
      // So the relayed response is an uncompressed body, never a mislabelled one.
      expect(head?.headers.some(([name]) => name.toLowerCase() === "content-encoding")).toBe(false);
      const { encoding, text } = decodeByHeader(head, body);
      expect(encoding).toBe("identity");
      expect(text).toContain("<title>ViewCode</title>");
      expect(text).toContain("Hello from ViewCode");
      expect(text).toContain('<script src="/app.js">');
    }
  });

  it("tells the relay when the local WebSocket closes", async () => {
    const { server, target } = await startLocal(mode, () => undefined);
    server.on("upgrade", (request, socket: NodeStream.Duplex) => {
      const accept = NodeCrypto.createHash("sha1")
        .update(`${request.headers["sec-websocket-key"]}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
        .digest("base64");
      socket.write(
        `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
      );
      // Close frame with code 4001.
      socket.end(Buffer.from([0x88, 2, 0x0f, 0xa1]));
    });
    const { relay, forwarder } = connect(target);
    forwarder.receive(
      makeJsonFrame(FrameType.WsOpen, 3, { path: "/ws", headers: [], protocols: [] }),
    );
    const close = parseWsClose((await relay.next(FrameType.WsClose, 3)).payload);
    expect(close?.code).toBe(4001);
  });
});
