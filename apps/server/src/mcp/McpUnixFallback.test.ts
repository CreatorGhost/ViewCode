// @effect-diagnostics nodeBuiltinImport:off - exercises the generated provider extension against a real private socket.
import * as NodeHttp from "node:http";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";
import * as NodeChildProcess from "node:child_process";
import * as NodeURL from "node:url";
import { describe, it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { callAcpMcpTool } from "./AcpMcpStdioBridge.ts";
import { fetchMcpEndpoint } from "./fetchMcpEndpoint.ts";
import { PI_MCP_FETCH_SOURCE } from "../../../../packages/provider-pi/src/server/mcpExtensionSource.ts";

describe("MCP fallback over a socket-only listener", () => {
  it.live("runs ACP tool calls and Pi extension requests with scoped credentials over Unix", () =>
    Effect.gen(function* () {
      const directory = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "viewcode-mcp-unix-")),
      );
      const socketPath = NodePath.join(directory, "mcp.sock");
      const seen: Array<{ method: string; auth: string | undefined; url: string | undefined }> = [];
      const server = NodeHttp.createServer((request, response) => {
        const chunks: Array<Buffer> = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const message = JSON.parse(Buffer.concat(chunks).toString());
          seen.push({
            method: message.method,
            auth: request.headers.authorization,
            url: request.url,
          });
          if (message.id === undefined) {
            response.writeHead(202).end();
            return;
          }
          const result =
            message.method === "initialize"
              ? {
                  protocolVersion: "2025-06-18",
                  capabilities: {},
                  serverInfo: { name: "fixture", version: "1" },
                }
              : { content: [{ type: "text", text: "socket tool succeeded" }] };
          response
            .writeHead(200, { "content-type": "application/json" })
            .end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        });
      });
      try {
        yield* Effect.promise(
          () =>
            new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(socketPath, resolve);
            }),
        );
        const result = yield* callAcpMcpTool({
          endpoint: `unix:${socketPath}`,
          authorization: "Bearer scoped-token",
          tool: "test_tool",
          arguments: {},
        });
        expect(result).toEqual({ content: [{ type: "text", text: "socket tool succeeded" }] });
        const piFetch = new NodeVM.Script(
          `${PI_MCP_FETCH_SOURCE}; fetchMcpEndpoint`,
        ).runInNewContext({ NodeHttp, Buffer, Headers, Response }) as typeof fetchMcpEndpoint;
        const response = yield* Effect.promise(() =>
          piFetch(`unix:${socketPath}`, {
            method: "POST",
            headers: { authorization: "Bearer scoped-token", "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/call" }),
          }),
        );
        expect(yield* Effect.promise(() => response.json())).toMatchObject({ result });
        // Exercise the real source/executable fast path rather than importing its bridge function.
        const bridge = NodeChildProcess.spawn(
          process.execPath,
          [
            NodeURL.fileURLToPath(new URL("../bin.ts", import.meta.url)),
            "__mcp-stdio-bridge",
            "--socket",
            socketPath,
          ],
          {
            env: { ...process.env, T3_MCP_BEARER_TOKEN: "scoped-token" },
            stdio: ["pipe", "pipe", "pipe"],
          },
        );
        let output = "";
        let errors = "";
        bridge.stdout.setEncoding("utf8").on("data", (chunk: string) => {
          output += chunk;
        });
        bridge.stderr.setEncoding("utf8").on("data", (chunk: string) => {
          errors += chunk;
        });
        const closed = new Promise<number | null>((resolve, reject) => {
          bridge.once("error", reject);
          bridge.once("close", resolve);
        });
        try {
          bridge.stdin.end(
            `${JSON.stringify({ jsonrpc: "2.0", id: 11, method: "initialize", params: {} })}\n${JSON.stringify({ jsonrpc: "2.0", id: 12, method: "tools/call", params: { name: "test_tool", arguments: {} } })}\n`,
          );
          expect(yield* Effect.promise(() => closed), errors).toBe(0);
          expect(
            output
              .split("\n")
              .filter(Boolean)
              .map((line) => JSON.parse(line)),
          ).toContainEqual({ jsonrpc: "2.0", id: 12, result });
        } finally {
          if (bridge.exitCode === null && !bridge.killed) bridge.kill("SIGTERM");
        }
        expect(
          seen.every((message) => message.auth === "Bearer scoped-token" && message.url === "/mcp"),
        ).toBe(true);
        expect(seen.map((message) => message.method)).toContain("tools/call");
      } finally {
        yield* Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));
        yield* Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true }));
      }
    }),
  );
});
