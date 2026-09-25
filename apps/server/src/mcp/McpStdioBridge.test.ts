// @effect-diagnostics nodeBuiltinImport:off - drives the plain-Node bridge against a real socket server.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStream from "node:stream";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpProtocol, McpServer } from "effect/unstable/ai";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseMcpStdioBridgeArgs, runMcpStdioBridge, takeSseEvents } from "./McpStdioBridge.ts";

interface SeenRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const startSocketServer = async (
  respond: (request: SeenRequest, response: NodeHttp.ServerResponse) => void,
) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-"));
  const socketPath = NodePath.join(directory, "server.sock");
  const seen: SeenRequest[] = [];
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
  await new Promise<void>((resolve) => server.listen(socketPath, resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) =>
        server.close(() => {
          NodeFS.rmSync(directory, { recursive: true, force: true });
          resolve();
        }),
      ),
  );
  return { socketPath, seen };
};

const runBridge = async (socketPath: string, lines: ReadonlyArray<string>) => {
  const input = NodeStream.Readable.from(lines.map((line) => `${line}\n`));
  const output = new NodeStream.PassThrough();
  let written = "";
  output.setEncoding("utf8");
  output.on("data", (chunk: string) => (written += chunk));
  await runMcpStdioBridge({ socketPath, token: "secret", input, output });
  return written
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
};

describe("MCP stdio bridge", () => {
  it("forwards requests with the credential and replays the MCP session id", async () => {
    const { socketPath, seen } = await startSocketServer((request, response) => {
      const message = JSON.parse(request.body) as { id?: number; method: string };
      if (message.method === "initialize") {
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "session-1",
        });
        response.end(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { protocolVersion: "2025-06-18" },
          }),
        );
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write(
        `event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\n`,
      );
      response.end(`data: {"jsonrpc":"2.0","id":${message.id},\ndata: "result":{"tools":[]}}\n\n`);
    });

    const replies = await runBridge(socketPath, [
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    ]);

    expect(replies).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
      { jsonrpc: "2.0", method: "notifications/progress" },
      { jsonrpc: "2.0", id: 2, result: { tools: [] } },
    ]);
    expect(seen.map((request) => [request.method, request.url])).toEqual([
      ["POST", "/mcp"],
      ["POST", "/mcp"],
      ["POST", "/mcp"],
    ]);
    expect(seen.every((request) => request.headers.authorization === "Bearer secret")).toBe(true);
    expect(seen[0]!.headers["mcp-session-id"]).toBeUndefined();
    expect(seen[2]!.headers["mcp-session-id"]).toBe("session-1");
    expect(seen[2]!.headers["mcp-protocol-version"]).toBe("2025-06-18");
  });

  effectIt.effect("speaks to Effect's streamable-HTTP MCP server over a Unix socket", () => {
    const handshake = [
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "bridge-test", version: "1.0.0" },
        },
      }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping", params: {} }),
    ];
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-bridge-mcp-"));
    const socketPath = NodePath.join(directory, "server.sock");

    return Effect.gen(function* () {
      const replies = yield* Effect.scoped(
        Effect.gen(function* () {
          yield* HttpRouter.serve(
            McpServer.layerHttp({
              name: "bridge test",
              version: "1.0.0",
              path: "/mcp",
              protocols: [McpProtocol.v2025_06_18],
            }),
            { disableListenLog: true, disableLogger: true },
          ).pipe(Layer.build);
          return yield* Effect.promise(() => runBridge(socketPath, handshake));
        }),
      );

      expect(replies).toHaveLength(2);
      expect(replies[0]).toMatchObject({
        jsonrpc: "2.0",
        id: 1,
        result: { protocolVersion: "2025-06-18", serverInfo: { name: "bridge test" } },
      });
      expect(replies[1]).toEqual({ jsonrpc: "2.0", id: 2, result: {} });
    }).pipe(
      Effect.provide(NodeHttpServer.layer(() => NodeHttp.createServer(), { path: socketPath })),
      Effect.ensuring(
        Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
      ),
    );
  });

  it("answers requests with a JSON-RPC error when the server rejects them", async () => {
    const { socketPath } = await startSocketServer((_request, response) => {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(`{"error":"invalid_mcp_credential"}`);
    });

    const replies = await runBridge(socketPath, [
      JSON.stringify({ jsonrpc: "2.0", id: "a", method: "tools/list" }),
      JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    ]);

    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ jsonrpc: "2.0", id: "a", error: { code: -32000 } });
    expect(String((replies[0]!.error as { message: string }).message)).toContain("HTTP 401");
  });

  it("answers requests with an error when the socket is gone", async () => {
    const replies = await runBridge(
      NodePath.join(NodeOS.tmpdir(), `t3-missing-${process.pid}.sock`),
      [JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" })],
    );
    expect(replies).toMatchObject([{ id: 7, error: { code: -32000 } }]);
  });

  it("parses SSE events split across chunks", () => {
    const first = takeSseEvents("data: one\n\ndata: t");
    expect(first).toEqual({ events: ["one"], rest: "data: t" });
    expect(takeSseEvents(`${first.rest}wo\r\n\r\n`)).toEqual({ events: ["two"], rest: "" });
  });

  it("reads the socket argument", () => {
    expect(parseMcpStdioBridgeArgs(["--socket", "/tmp/a.sock"])).toEqual({
      socketPath: "/tmp/a.sock",
    });
    expect(parseMcpStdioBridgeArgs(["--socket=\\\\.\\pipe\\t3"])).toEqual({
      socketPath: "\\\\.\\pipe\\t3",
    });
    expect(parseMcpStdioBridgeArgs([])).toHaveProperty("error");
  });
});
