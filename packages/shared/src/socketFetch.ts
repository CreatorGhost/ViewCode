// @effect-diagnostics nodeBuiltinImport:off globalFetch:off -- Local transport boundary shared by native MCP and CLI processes.
import * as NodeHttp from "node:http";
import * as NodeStream from "node:stream";

/** Preserve HTTP request/response semantics while dialing only the given local socket or named pipe. */
export function makeSocketFetch(socketPath: string): typeof globalThis.fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.body === null ? undefined : new Uint8Array(await request.arrayBuffer());
    return new Promise<Response>((resolve, reject) => {
      const outgoing = NodeHttp.request(
        {
          socketPath,
          path: `${url.pathname}${url.search}`,
          method: request.method,
          headers: Object.fromEntries(request.headers),
          signal: request.signal,
        },
        (incoming) => {
          const headers = new Headers();
          for (let index = 0; index < incoming.rawHeaders.length; index += 2) {
            headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
          }
          const status = incoming.statusCode ?? 500;
          const empty = status === 204 || status === 205 || status === 304;
          if (empty) incoming.resume();
          resolve(
            new Response(
              empty ? null : (NodeStream.Readable.toWeb(incoming) as ReadableStream<Uint8Array>),
              {
                status,
                ...(incoming.statusMessage === undefined
                  ? {}
                  : { statusText: incoming.statusMessage }),
                headers,
              },
            ),
          );
        },
      );
      outgoing.on("error", reject);
      outgoing.end(body);
    });
  };
}

/** Provider sessions use an opaque unix: endpoint; the HTTP route stays native /mcp. */
export function fetchMcpEndpoint(endpoint: string, init?: RequestInit): Promise<Response> {
  return endpoint.startsWith("unix:")
    ? makeSocketFetch(endpoint.slice("unix:".length))("http://localhost/mcp", init)
    : fetch(endpoint, init);
}
