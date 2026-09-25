// @effect-diagnostics nodeBuiltinImport:off - runs before and outside the Effect runtime; must start fast.
/**
 * A stdio MCP server that forwards every message to the T3 Code server's
 * streamable-HTTP `/mcp` endpoint over a Unix socket or named pipe.
 *
 * Providers normally reach `/mcp` by URL. A server that listens on a socket
 * has no URL a provider can dial, so providers launch this bridge instead:
 * `node mcp-stdio-bridge.mjs --socket <path>` with the provider-scoped bearer
 * credential in `T3_MCP_BEARER_TOKEN`. It speaks newline-delimited JSON-RPC on
 * stdin/stdout, the MCP stdio transport, and keeps no state beyond the MCP
 * session id the server hands back.
 *
 * Plain Node on purpose: providers start one bridge per session, so it must
 * start fast and must not load the server bundle.
 */
import * as NodeHttp from "node:http";
import * as NodeReadline from "node:readline";

export const MCP_STDIO_BRIDGE_TOKEN_ENV = "T3_MCP_BEARER_TOKEN";

export interface McpStdioBridgeOptions {
  readonly socketPath: string;
  readonly token: string;
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;
  /** Endpoint path on the server. */
  readonly path?: string;
}

type JsonRpcId = string | number;

const requestIdsOf = (message: unknown): ReadonlyArray<JsonRpcId> => {
  const messages = Array.isArray(message) ? message : [message];
  const ids: JsonRpcId[] = [];
  for (const entry of messages) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      "method" in entry &&
      "id" in entry &&
      (typeof entry.id === "string" || typeof entry.id === "number")
    ) {
      ids.push(entry.id);
    }
  }
  return ids;
};

const isInitializeRequest = (message: unknown): message is { readonly id: JsonRpcId } =>
  typeof message === "object" &&
  message !== null &&
  "method" in message &&
  message.method === "initialize" &&
  "id" in message;

/**
 * Splits a `text/event-stream` body into the `data` payloads of its events.
 * Returns the complete payloads and the unparsed remainder.
 */
export const takeSseEvents = (
  buffer: string,
): { readonly events: ReadonlyArray<string>; readonly rest: string } => {
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  const events: string[] = [];
  for (const block of blocks) {
    const data = block
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(line.startsWith("data: ") ? 6 : 5));
    if (data.length > 0) events.push(data.join("\n"));
  }
  return { events, rest };
};

/** Runs the bridge until `input` ends and every forwarded request settles. */
export const runMcpStdioBridge = (options: McpStdioBridgeOptions): Promise<void> => {
  const endpointPath = options.path ?? "/mcp";
  let sessionId: string | undefined;
  let protocolVersion: string | undefined;
  const inFlight = new Set<Promise<void>>();
  let initialized: Promise<void> = Promise.resolve();

  const emit = (message: unknown) => {
    options.output.write(`${JSON.stringify(message)}\n`);
  };

  const emitPayload = (payload: string) => {
    const trimmed = payload.trim();
    if (trimmed.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    for (const message of Array.isArray(parsed) ? parsed : [parsed]) {
      rememberProtocolVersion(message);
      emit(message);
    }
  };

  let pendingInitializeId: JsonRpcId | undefined;
  const rememberProtocolVersion = (message: unknown) => {
    if (
      pendingInitializeId === undefined ||
      typeof message !== "object" ||
      message === null ||
      !("id" in message) ||
      message.id !== pendingInitializeId ||
      !("result" in message)
    ) {
      return;
    }
    const result = message.result;
    if (
      typeof result === "object" &&
      result !== null &&
      "protocolVersion" in result &&
      typeof result.protocolVersion === "string"
    ) {
      protocolVersion = result.protocolVersion;
    }
    pendingInitializeId = undefined;
  };

  const failRequests = (message: unknown, detail: string) => {
    for (const id of requestIdsOf(message)) {
      emit({
        jsonrpc: "2.0",
        id,
        error: { code: -32000, message: `T3 Code MCP bridge: ${detail}` },
      });
    }
  };

  const forward = (message: unknown, body: string) =>
    new Promise<void>((resolve) => {
      if (isInitializeRequest(message)) pendingInitializeId = message.id;
      const request = NodeHttp.request(
        {
          socketPath: options.socketPath,
          path: endpointPath,
          method: "POST",
          headers: {
            host: "localhost",
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${options.token}`,
            ...(sessionId === undefined ? {} : { "mcp-session-id": sessionId }),
            ...(protocolVersion === undefined ? {} : { "mcp-protocol-version": protocolVersion }),
          },
        },
        (response) => {
          const returnedSessionId = response.headers["mcp-session-id"];
          if (typeof returnedSessionId === "string" && returnedSessionId.length > 0) {
            sessionId = returnedSessionId;
          }
          const status = response.statusCode ?? 0;
          const contentType = String(response.headers["content-type"] ?? "");
          response.setEncoding("utf8");
          let buffer = "";
          response.on("data", (chunk: string) => {
            buffer += chunk;
            if (status < 400 && contentType.includes("text/event-stream")) {
              const { events, rest } = takeSseEvents(buffer);
              buffer = rest;
              for (const event of events) emitPayload(event);
            }
          });
          response.on("end", () => {
            if (status >= 400) {
              failRequests(message, `HTTP ${status}${buffer ? `: ${buffer.slice(0, 500)}` : ""}`);
            } else if (contentType.includes("text/event-stream")) {
              const { events } = takeSseEvents(`${buffer}\n\n`);
              for (const event of events) emitPayload(event);
            } else {
              emitPayload(buffer);
            }
            resolve();
          });
          response.on("error", (error) => {
            failRequests(message, error.message);
            resolve();
          });
        },
      );
      request.on("error", (error) => {
        failRequests(message, `could not reach the server (${error.message})`);
        resolve();
      });
      request.end(body);
    });

  return new Promise<void>((resolve) => {
    const lines = NodeReadline.createInterface({ input: options.input, crlfDelay: Infinity });
    lines.on("line", (line) => {
      const body = line.trim();
      if (body.length === 0) return;
      let message: unknown;
      try {
        message = JSON.parse(body);
      } catch {
        emit({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      // Everything after `initialize` waits for its reply, which carries the
      // session id and protocol version later requests must present.
      const send = () => forward(message, body);
      const pending = (
        isInitializeRequest(message)
          ? (initialized = initialized.then(send))
          : initialized.then(send)
      ).finally(() => inFlight.delete(pending));
      inFlight.add(pending);
    });
    lines.on("close", () => {
      void Promise.all(inFlight).then(() => resolve());
    });
  });
};

/** Parses `--socket <path>` (or `--socket=<path>`) from bridge arguments. */
export const parseMcpStdioBridgeArgs = (
  args: ReadonlyArray<string>,
): { readonly socketPath: string } | { readonly error: string } => {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--socket") {
      const value = args[index + 1];
      if (value) return { socketPath: value };
    } else if (arg.startsWith("--socket=")) {
      const value = arg.slice("--socket=".length);
      if (value) return { socketPath: value };
    }
  }
  return { error: "Usage: mcp-stdio-bridge --socket <path>" };
};

/** Entry point shared by the standalone script and the executable's subcommand. */
export const runMcpStdioBridgeMain = async (args: ReadonlyArray<string>): Promise<number> => {
  const parsed = parseMcpStdioBridgeArgs(args);
  if ("error" in parsed) {
    process.stderr.write(`${parsed.error}\n`);
    return 2;
  }
  const token = process.env[MCP_STDIO_BRIDGE_TOKEN_ENV] ?? "";
  if (token.length === 0) {
    process.stderr.write(`${MCP_STDIO_BRIDGE_TOKEN_ENV} is not set.\n`);
    return 2;
  }
  await runMcpStdioBridge({
    socketPath: parsed.socketPath,
    token,
    input: process.stdin,
    output: process.stdout,
  });
  return 0;
};
