import type { DesktopBridge, DesktopLocalBackendSocketHandlers } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { DesktopBackendWebSocket, installDesktopBackendWebSocket } from "./desktopBackendWebSocket";

const makeBridge = () => {
  const opened: Array<{
    url: string;
    protocols: readonly string[];
    handlers: DesktopLocalBackendSocketHandlers;
    send: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const openLocalBackendSocket: NonNullable<DesktopBridge["openLocalBackendSocket"]> = (
    url,
    protocols,
    handlers,
  ) => {
    const entry = { url, protocols, handlers, send: vi.fn(), close: vi.fn() };
    opened.push(entry);
    return { send: entry.send, close: entry.close };
  };
  return { opened, openLocalBackendSocket };
};

class FakeNativeWebSocket {
  static readonly OPEN = 1;
  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {}
}

describe("desktop backend WebSocket", () => {
  it("tunnels only local backend URLs and leaves remote ones on the native socket", () => {
    const bridge = makeBridge();
    const target = {
      WebSocket: FakeNativeWebSocket as unknown as typeof WebSocket,
      desktopBridge: { openLocalBackendSocket: bridge.openLocalBackendSocket } as DesktopBridge,
    };
    installDesktopBackendWebSocket(target);
    installDesktopBackendWebSocket(target);

    const remote = new target.WebSocket("wss://remote.example/ws", "proto");
    expect(remote).toBeInstanceOf(FakeNativeWebSocket);
    expect(target.WebSocket.OPEN).toBe(1);

    const local = new target.WebSocket("t3code-backend://primary/ws?wsToken=t", ["a"]);
    expect(local).toBeInstanceOf(DesktopBackendWebSocket);
    expect(bridge.opened).toHaveLength(1);
    expect(bridge.opened[0]).toMatchObject({
      url: "t3code-backend://primary/ws?wsToken=t",
      protocols: ["a"],
    });
  });

  it("does nothing outside the desktop app", () => {
    const target = { WebSocket: FakeNativeWebSocket as unknown as typeof WebSocket };
    installDesktopBackendWebSocket(target);
    expect(target.WebSocket).toBe(FakeNativeWebSocket);
  });

  it("behaves like a WebSocket across open, messages, send, and close", async () => {
    const bridge = makeBridge();
    const socket = new DesktopBackendWebSocket(
      "t3code-backend://primary/ws",
      undefined,
      bridge.openLocalBackendSocket,
    );
    const { handlers, send, close } = bridge.opened[0]!;
    const events: string[] = [];
    socket.onopen = () => events.push("onopen");
    socket.addEventListener("open", () => events.push("open"));
    socket.addEventListener("message", (event) =>
      events.push(`message:${String((event as MessageEvent).data)}`),
    );
    socket.onclose = (event) => events.push(`close:${event.code}:${event.reason}`);

    expect(socket.readyState).toBe(WebSocket.CONNECTING);
    expect(() => socket.send("early")).toThrow();

    handlers.onOpen({ protocol: "", extensions: "" });
    expect(socket.readyState).toBe(WebSocket.OPEN);

    handlers.onMessage("text");
    socket.binaryType = "arraybuffer";
    const payload = new Uint8Array([7]).buffer;
    let binary: unknown;
    socket.addEventListener("message", (event) => (binary = (event as MessageEvent).data), {
      once: true,
    });
    handlers.onMessage(payload);
    expect(binary).toBe(payload);

    socket.send("hi");
    socket.send(new Blob(["blob"]));
    socket.send(new Uint8Array([1, 2]));
    socket.close(1000, "done");
    // The Blob reads asynchronously; the frames after it and the close wait.
    expect(send.mock.calls.map(([data]) => data)).toEqual(["hi"]);
    expect(close).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(close).toHaveBeenCalledWith(1000, "done"));
    expect(send.mock.calls.map(([data]) => data)).toEqual([
      "hi",
      new TextEncoder().encode("blob").buffer,
      new Uint8Array([1, 2]),
    ]);

    expect(socket.readyState).toBe(WebSocket.CLOSING);
    handlers.onClose({ code: 1000, reason: "done", wasClean: true });
    expect(socket.readyState).toBe(WebSocket.CLOSED);

    expect(events).toEqual([
      "onopen",
      "open",
      "message:text",
      "message:[object ArrayBuffer]",
      "close:1000:done",
    ]);
  });
});
