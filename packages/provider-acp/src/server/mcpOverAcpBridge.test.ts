import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- Native MCP-over-ACP transport regression uses a scoped Unix HTTP listener.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeAcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";

describe("AcpMcpOverAcpBridge", () => {
  it.effect("forwards authenticated MCP requests and closes the negotiated session", () =>
    Effect.gen(function* () {
      const requests: Array<{
        readonly method: string;
        readonly headers: Headers;
        readonly body: unknown;
      }> = [];
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: async (_url, init) => {
          const method = init?.method ?? "GET";
          const headers = new Headers(init?.headers);
          const body = init?.body === undefined ? null : JSON.parse(String(init.body));
          requests.push({ method, headers, body });
          if (method === "DELETE") return new Response(null, { status: 204 });
          if (body === null || typeof body !== "object") return new Response(null, { status: 202 });
          const request = body as { readonly id?: unknown; readonly method?: unknown };
          if (request.method === "notifications/initialized") {
            return new Response(null, { status: 202 });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: request.id,
              result:
                request.method === "initialize"
                  ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: {} }
                  : { tools: [] },
            }),
            {
              headers: { "content-type": "application/json", "mcp-session-id": "session-42" },
            },
          );
        },
      });

      const connected = yield* bridge.connect({ serverId: "t3-code" });
      expect(connected).toEqual({ connectionId: "connection-1" });
      expect(
        yield* bridge.message({ connectionId: connected.connectionId, method: "initialize" }),
      ).toMatchObject({ protocolVersion: "2025-06-18" });
      expect(
        yield* bridge.message({ connectionId: connected.connectionId, method: "tools/list" }),
      ).toEqual({ tools: [] });
      yield* bridge.notification({
        connectionId: connected.connectionId,
        method: "notifications/initialized",
      });
      yield* bridge.disconnect({ connectionId: connected.connectionId });

      expect(requests[0]?.headers.get("authorization")).toBe("Bearer bridge-test");
      expect(requests[1]?.headers.get("mcp-session-id")).toBe("session-42");
      expect(requests[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
      expect(requests.at(-1)?.method).toBe("DELETE");
      expect(requests.at(-1)?.headers.get("mcp-session-id")).toBe("session-42");
    }),
  );

  it.effect("aborts an in-flight HTTP request when the ACP call is interrupted", () =>
    Effect.gen(function* () {
      const started = Promise.withResolvers<AbortSignal>();
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: (_url, init) => {
          if (!init?.signal) throw new Error("Missing cancellation signal");
          started.resolve(init.signal);
          return new Promise<Response>(() => {});
        },
      });
      const connected = yield* bridge.connect({ serverId: "t3-code" });
      const request = yield* bridge
        .message({ connectionId: connected.connectionId, method: "tools/list" })
        .pipe(Effect.forkChild);
      const signal = yield* Effect.promise(() => started.promise);
      yield* Fiber.interrupt(request);
      expect(signal.aborted).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("rejects unknown servers, connections, and oversized messages", () =>
    Effect.gen(function* () {
      const bridge = yield* makeAcpMcpOverAcpBridge({
        endpoint: "http://127.0.0.1:1/mcp",
        authorization: "Bearer bridge-test",
        allocateConnectionId: Effect.succeed("connection-1"),
        fetchImplementation: () => Promise.resolve(new Response(null, { status: 202 })),
      });

      expect(yield* bridge.connect({ serverId: "other" }).pipe(Effect.flip)).toMatchObject({
        _tag: "AcpMcpOverAcpError",
      });
      expect(
        yield* bridge.message({ connectionId: "missing", method: "tools/list" }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "AcpMcpOverAcpError" });

      const connected = yield* bridge.connect({ serverId: "t3-code" });
      const failure = yield* bridge
        .message({
          connectionId: connected.connectionId,
          method: "tools/call",
          params: { payload: "x".repeat(8 * 1024 * 1024) },
        })
        .pipe(Effect.flip);
      expect(failure.message).toContain("exceeds 8 MiB");
    }),
  );
});

it.effect("negotiates and calls native MCP over a socket without a TCP fallback", () =>
  Effect.gen(function* () {
    const directory = yield* Effect.promise(() =>
      NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-acpmcp-")),
    );
    const socketPath =
      HostProcess.Platform.defaultValue() === "win32"
        ? `\\\\.\\pipe\\${NodePath.basename(directory)}`
        : NodePath.join(directory, "s.sock");
    const requests: Array<{
      method: string | undefined;
      path: string | undefined;
      headers: NodeHttp.IncomingHttpHeaders;
    }> = [];
    const server = NodeHttp.createServer((request, response) => {
      requests.push({ method: request.method, path: request.url, headers: request.headers });
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk) => {
        body += chunk;
      });
      request.on("end", () => {
        if (request.method === "DELETE") {
          response.writeHead(204);
          response.end();
          return;
        }
        const input = JSON.parse(body) as { id?: number; method: string | undefined };
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "socket-session",
        });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: input.id,
            result:
              input.method === "initialize"
                ? { protocolVersion: "2025-06-18" }
                : { content: [{ type: "text", text: "native socket tool" }] },
          }),
        );
      });
    });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }),
    );
    yield* Effect.promise(
      () =>
        new Promise<void>((resolve, reject) => {
          server.once("error", reject);
          server.listen(socketPath, resolve);
        }),
    );
    expect(server.address()).toBe(socketPath);
    const bridge = yield* makeAcpMcpOverAcpBridge({
      endpoint: `unix:${socketPath}`,
      authorization: "Bearer socket-test-only",
      allocateConnectionId: Effect.succeed("socket-connection"),
    });
    const { connectionId } = yield* bridge.connect({ serverId: "t3-code" });
    expect(yield* bridge.message({ connectionId, method: "initialize" })).toEqual({
      protocolVersion: "2025-06-18",
    });
    expect(
      yield* bridge.message({
        connectionId,
        method: "tools/call",
        params: { name: "delegate_task", arguments: {} },
      }),
    ).toEqual({ content: [{ type: "text", text: "native socket tool" }] });
    yield* bridge.disconnect({ connectionId });
    expect(requests.map((request) => [request.method, request.path])).toEqual([
      ["POST", "/mcp"],
      ["POST", "/mcp"],
      ["DELETE", "/mcp"],
    ]);
    expect(
      requests.every((request) => request.headers.authorization === "Bearer socket-test-only"),
    ).toBe(true);
    expect(requests[1]?.headers["mcp-session-id"]).toBe("socket-session");
    expect(requests[1]?.headers["mcp-protocol-version"]).toBe("2025-06-18");
  }).pipe(Effect.scoped),
);
