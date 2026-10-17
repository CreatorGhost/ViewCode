// @effect-diagnostics nodeBuiltinImport:off globalFetch:off - stdio fast paths run before the Effect runtime.
import * as NodeHttp from "node:http";

/** The ACP terminal fallback also reaches the desktop's socket-only MCP listener. */
export function fetchMcpEndpoint(endpoint: string, init: RequestInit = {}): Promise<Response> {
  if (!endpoint.startsWith("unix:")) return fetch(endpoint, init);
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request({
      socketPath: endpoint.slice("unix:".length), path: "/mcp", method: init.method ?? "POST",
      headers: Object.fromEntries(new Headers(init.headers)),
      ...(init.signal ? { signal: init.signal } : {}),
    }, (response) => {
      const chunks: Array<Buffer> = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) headers.append(response.rawHeaders[i]!, response.rawHeaders[i + 1]!);
        const status = response.statusCode ?? 500;
        resolve(new Response(status === 204 || status === 304 ? null : Buffer.concat(chunks), { status, headers }));
      });
    });
    request.on("error", reject);
    if (init.body !== undefined && init.body !== null && typeof init.body !== "string" && !(init.body instanceof Uint8Array)) {
      request.destroy(new TypeError("The MCP bridge accepts JSON request bodies."));
      return;
    }
    request.end(init.body);
  });
}
