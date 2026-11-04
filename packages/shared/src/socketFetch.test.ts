import * as HostProcess from "@t3tools/shared/HostProcess";
// @effect-diagnostics nodeBuiltinImport:off -- Exercises real local HTTP sockets without opening a TCP listener.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, expect, it } from "vite-plus/test";

import { fetchMcpEndpoint, makeSocketFetch } from "./socketFetch.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function socketServer(handler: NodeHttp.RequestListener) {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-fetch-"));
  const socketPath =
    HostProcess.Platform.defaultValue() === "win32"
      ? `\\\\.\\pipe\\${NodePath.basename(directory)}`
      : NodePath.join(directory, "s.sock");
  const server = NodeHttp.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await NodeFSP.rm(directory, { recursive: true, force: true });
  });
  expect(server.address()).toBe(socketPath);
  return socketPath;
}

it("keeps native HTTP path, method, headers and request body on the socket", async () => {
  const seen = Promise.withResolvers<{
    url: string | undefined;
    method: string | undefined;
    authorization: string | undefined;
    body: string;
  }>();
  const socketPath = await socketServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.resolve({
        url: request.url,
        method: request.method,
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      response.writeHead(201, { "content-type": "application/json", "x-native-route": "projects" });
      response.end('{"accepted":true}');
    });
  });
  const response = await makeSocketFetch(socketPath)(
    new Request("http://unused.invalid/api/projects?mode=live", {
      method: "POST",
      headers: { authorization: "Bearer test-only", "content-type": "application/json" },
      body: '{"title":"socket project"}',
    }),
  );
  expect(await seen.promise).toEqual({
    url: "/api/projects?mode=live",
    method: "POST",
    authorization: "Bearer test-only",
    body: '{"title":"socket project"}',
  });
  expect(response.status).toBe(201);
  expect(response.headers.get("x-native-route")).toBe("projects");
  expect(await response.json()).toEqual({ accepted: true });
});

it("streams MCP events before the server closes the response", async () => {
  const accepted = Promise.withResolvers<NodeHttp.ServerResponse>();
  const socketPath = await socketServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('data: {"ready":true}\n\n');
    accepted.resolve(response);
  });
  const response = await fetchMcpEndpoint(`unix:${socketPath}`, { method: "POST", body: "{}" });
  const reader = response.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: {"ready":true}\n\n');
  const nativeResponse = await accepted.promise;
  expect(nativeResponse.writableEnded).toBe(false);
  nativeResponse.end();
  expect((await reader.read()).done).toBe(true);
});

it("cancels the socket response when the caller aborts", async () => {
  const closed = Promise.withResolvers<void>();
  const socketPath = await socketServer((_request, response) => {
    response.on("close", () => closed.resolve());
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.flushHeaders();
  });
  const controller = new AbortController();
  const response = await makeSocketFetch(socketPath)("http://unused.invalid/mcp", {
    signal: controller.signal,
  });
  const read = response.body!.getReader().read();
  controller.abort();
  await expect(read).rejects.toThrow();
  await closed.promise;
});

it("preserves bodyless HTTP statuses for native MCP disconnect", async () => {
  const socketPath = await socketServer((request, response) => {
    expect(request.url).toBe("/mcp");
    expect(request.method).toBe("DELETE");
    response.writeHead(204);
    response.end();
  });
  const response = await fetchMcpEndpoint(`unix:${socketPath}`, { method: "DELETE" });
  expect(response.status).toBe(204);
  expect(response.body).toBeNull();
});

it("keeps ordinary TCP MCP requests on the native fetch path", async () => {
  const seen = Promise.withResolvers<{
    url: string | undefined;
    authorization: string | undefined;
  }>();
  const server = NodeHttp.createServer((request, response) => {
    seen.resolve({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" });
    response.end('{"transport":"tcp"}');
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  cleanups.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Expected test TCP listener");
  const response = await fetchMcpEndpoint(`http://127.0.0.1:${address.port}/mcp`, {
    method: "POST",
    headers: { authorization: "Bearer tcp-test-only" },
    body: "{}",
  });
  expect(await seen.promise).toEqual({ url: "/mcp", authorization: "Bearer tcp-test-only" });
  expect(await response.json()).toEqual({ transport: "tcp" });
});
