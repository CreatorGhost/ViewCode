import { describe, expect, it } from "vite-plus/test";

import {
  chunkBody,
  CreditGate,
  CreditWindow,
  decodeCredit,
  decodeFrame,
  decodeWsMessage,
  encodeCredit,
  encodeWsMessage,
  forwardableHeaders,
  FrameType,
  makeFrame,
  makeJsonFrame,
  MAX_BODY_CHUNK_BYTES,
  openPayload,
  parseRequestHead,
  parseResponseHead,
  parseWsClose,
  parseWsOpen,
  timingSafeEqualBytes,
  type FrameSealer,
} from "./viewcodeRelayProtocol.ts";

const bytes = (...values: number[]) => Uint8Array.from(values);

describe("frame codec", () => {
  it("round trips type, stream id and payload", () => {
    const frame = decodeFrame(makeFrame(FrameType.ResponseBody, 0xdead_beef, bytes(1, 2, 3)));
    expect(frame).toMatchObject({ type: FrameType.ResponseBody, streamId: 0xdead_beef });
    expect(frame?.sealed).toBe(false);
    expect([...(frame?.payload ?? [])]).toEqual([1, 2, 3]);
  });

  it("rejects short, unknown and flagged-unknown frames", () => {
    expect(decodeFrame(bytes(0x10, 0, 0))).toBeNull();
    expect(decodeFrame(bytes(0x99, 0, 0, 0, 0, 1))).toBeNull();
    expect(decodeFrame(bytes(FrameType.Abort, 0b10, 0, 0, 0, 1))).toBeNull();
  });

  it("round trips JSON heads and validates their shape", () => {
    const head = { method: "POST", path: "/api/x?y=1", headers: [["a", "b"]], hasBody: true };
    const frame = decodeFrame(makeJsonFrame(FrameType.RequestHead, 7, head));
    expect(parseRequestHead(frame!.payload)).toEqual(head);
    expect(parseRequestHead(new TextEncoder().encode('{"method":"GET"}'))).toBeNull();
    expect(
      parseRequestHead(
        new TextEncoder().encode('{"method":"GET","path":"//x","headers":[],"hasBody":false}'),
      ),
    ).not.toBeNull();
    expect(parseResponseHead(new TextEncoder().encode('{"status":99,"headers":[]}'))).toBeNull();
    expect(
      parseWsOpen(new TextEncoder().encode('{"path":"/ws","headers":[],"protocols":["a"]}')),
    ).toEqual({ path: "/ws", headers: [], protocols: ["a"] });
    expect(parseWsClose(new TextEncoder().encode('{"code":1000,"reason":""}'))).toEqual({
      code: 1000,
      reason: "",
    });
  });

  it("carries credits and WebSocket message kinds", () => {
    expect(decodeCredit(encodeCredit(123_456))).toBe(123_456);
    expect(decodeCredit(bytes(1, 2))).toBeNull();
    expect(decodeWsMessage(encodeWsMessage("text", bytes(104, 105)))).toEqual({
      kind: "text",
      data: bytes(104, 105),
    });
    expect(decodeWsMessage(encodeWsMessage("binary", bytes(9)))?.kind).toBe("binary");
    expect(decodeWsMessage(bytes(5, 1))).toBeNull();
  });

  it("seals and opens payloads only with the matching sealer", () => {
    const sealer: FrameSealer = {
      seal: (plain) => plain.map((byte) => byte ^ 0x5a),
      open: (sealed) => sealed.map((byte) => byte ^ 0x5a),
    };
    const frame = decodeFrame(makeFrame(FrameType.WsMessage, 1, bytes(1, 2, 3), sealer))!;
    expect(frame.sealed).toBe(true);
    expect([...frame.payload]).not.toEqual([1, 2, 3]);
    expect([...(openPayload(frame, sealer) ?? [])]).toEqual([1, 2, 3]);
    // A sealed frame is never handed out as plaintext, and plaintext is refused when sealing is required.
    expect(openPayload(frame)).toBeNull();
    const plain = decodeFrame(makeFrame(FrameType.WsMessage, 1, bytes(1)))!;
    expect(openPayload(plain, sealer)).toBeNull();
  });
});

describe("chunkBody", () => {
  it("cuts on the chunk limit and reassembles byte for byte", () => {
    const body = new Uint8Array(MAX_BODY_CHUNK_BYTES * 2 + 17).map((_, index) => index % 251);
    const chunks = [...chunkBody(body)];
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([
      MAX_BODY_CHUNK_BYTES,
      MAX_BODY_CHUNK_BYTES,
      17,
    ]);
    const joined = new Uint8Array(body.byteLength);
    let offset = 0;
    for (const chunk of chunks) {
      joined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(joined).toEqual(body);
  });

  it("yields nothing for an empty body and honours a custom limit", () => {
    expect([...chunkBody(new Uint8Array(0))]).toEqual([]);
    expect([...chunkBody(bytes(1, 2, 3, 4, 5), 2)].map((chunk) => chunk.byteLength)).toEqual([
      2, 2, 1,
    ]);
  });
});

describe("forwardableHeaders", () => {
  it("drops hop-by-hop and edge headers and lower-cases names", () => {
    expect(
      forwardableHeaders([
        ["Connection", "keep-alive"],
        ["Upgrade", "websocket"],
        ["Host", "relay.example"],
        ["CF-Connecting-IP", "1.2.3.4"],
        ["X-Forwarded-For", "1.2.3.4"],
        ["Authorization", "Bearer x"],
        ["Content-Type", "application/json"],
      ]),
    ).toEqual([
      ["authorization", "Bearer x"],
      ["content-type", "application/json"],
    ]);
  });
});

describe("CreditWindow", () => {
  it("caps bytes in flight and frees them on credit", () => {
    const window = new CreditWindow(100);
    expect(window.reserve(60)).toBe(60);
    expect(window.reserve(60)).toBe(40);
    expect(window.reserve(1)).toBe(0);
    window.release(50);
    expect(window.available).toBe(50);
    window.release(1_000);
    expect(window.inFlight).toBe(0);
  });
});

describe("timingSafeEqualBytes", () => {
  it("compares by content and length", () => {
    expect(timingSafeEqualBytes(bytes(1, 2), bytes(1, 2))).toBe(true);
    expect(timingSafeEqualBytes(bytes(1, 2), bytes(1, 3))).toBe(false);
    expect(timingSafeEqualBytes(bytes(1, 2), bytes(1, 2, 0))).toBe(false);
  });
});

describe("CreditGate", () => {
  it("holds a sender until credit arrives, in order, and fails waiters on close", async () => {
    const gate = new CreditGate(100);
    await gate.acquire(80);
    const order: string[] = [];
    const big = gate.acquire(60).then(() => order.push("big"));
    const small = gate.acquire(10).then(() => order.push("small"));
    await Promise.resolve();
    expect(order).toEqual([]);
    gate.release(80);
    await Promise.all([big, small]);
    expect(order).toEqual(["big", "small"]);
    expect(gate.inFlight).toBe(70);

    const stuck = gate.acquire(100);
    gate.close(new Error("gone"));
    await expect(stuck).rejects.toThrow("gone");
    await expect(gate.acquire(1)).rejects.toThrow("gone");
  });
});
