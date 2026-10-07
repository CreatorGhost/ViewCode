// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - drives the plain-Node CLI against real HTTP servers.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  COMPUTER_USE_KEY_PATTERN,
  ComputerUseRequest,
  ComputerUseResponse,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  CLI_KEY_PATTERN,
  COMPUTER_CLI_MANUAL,
  isComputerUseResponse,
  parseComputerArgs,
  runComputerCli,
} from "./ComputerUseCli.ts";

interface SeenRequest {
  readonly url: string;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: string;
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const listen = async (server: NodeHttp.Server, target: number): Promise<NodeHttp.Server> => {
  await new Promise<void>((resolve) => server.listen(target, "127.0.0.1", resolve));
  return server;
};

/** A server on a unix socket (and an equivalent TCP endpoint) that answers with `reply`. */
const startServer = async (reply: { readonly status?: number; readonly body: string }) => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-cli-"));
  const socketPath = NodePath.join(directory, "server.sock");
  const seen: SeenRequest[] = [];
  const handler: NodeHttp.RequestListener = (request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", headers: request.headers, body });
      response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      response.end(reply.body);
    });
  };
  const unixServer = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));
  const tcpServer = await listen(NodeHttp.createServer(handler), 0);
  const port = (tcpServer.address() as NodeNet.AddressInfo).port;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  return {
    seen,
    unixEndpoint: `unix:${socketPath}`,
    httpEndpoint: `http://127.0.0.1:${port}/api/computer-use`,
  };
};

const run = async (
  argv: ReadonlyArray<string>,
  options: { readonly endpoint?: string; readonly stdin?: string } = {},
) => {
  let stdout = "";
  const code = await runComputerCli({
    argv,
    env: options.endpoint
      ? { VIEWCODE_COMPUTER_ENDPOINT: options.endpoint, VIEWCODE_COMPUTER_AUTH: "Bearer test" }
      : {},
    readStdin: async () => options.stdin ?? "",
    writeStdout: (text) => (stdout += text),
  });
  return { code, stdout };
};

const outputOf = (stdout: string) => {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  return JSON.parse(stdout) as {
    readonly ok: boolean;
    readonly error?: { readonly code: string };
    readonly result?: unknown;
  };
};

const isContractResponse = Schema.is(ComputerUseResponse);
const decodeContractRequest = Schema.decodeUnknownSync(ComputerUseRequest);
const OK_INPUT = JSON.stringify({ ok: true, result: { kind: "input", effect: "dispatched" } });

describe("argv validation", () => {
  it.each([
    [["frobnicate"], "CU-VAL-001"],
    [[], "CU-VAL-002"],
    [["observe"], "CU-VAL-002"],
    [["observe", "--window"], "CU-VAL-002"],
    [["set-value", "--ref", "3"], "CU-VAL-002"],
    [["key", "--window", "1"], "CU-VAL-002"],
    [["scroll", "--ref", "1"], "CU-VAL-002"],
    [["observe", "--window", "abc"], "CU-VAL-003"],
    [["observe", "--window", "1.5"], "CU-VAL-003"],
    [["observe", "--window", "0"], "CU-VAL-003"],
    [["press", "--ref", "-2"], "CU-VAL-003"],
    [["scroll", "--ref", "1", "--dy", "51"], "CU-VAL-003"],
    [["key", "--window", "1", "--keys", "cmd+"], "CU-VAL-003"],
    [["key", "--window", "1", "--keys", "hyper+a"], "CU-VAL-003"],
    [["list-windows", "--app", "x".repeat(201)], "CU-VAL-003"],
    [["type", "--ref", "1", "--text", ""], "CU-VAL-003"],
    [["type", "--ref", "1", "--text", "x".repeat(10_001)], "CU-VAL-003"],
    [["press", "--ref", "1", "--window", "2"], "CU-VAL-004"],
    [["status", "--verbose"], "CU-VAL-004"],
    [["press", "--ref", "1", "--ref", "2"], "CU-VAL-004"],
    [["press", "4"], "CU-VAL-004"],
    [["help", "observe"], "CU-VAL-004"],
    [["click", "--shot", "1", "--x", "5"], "CU-VAL-002"],
    [["click", "--shot", "1", "--x", "-5", "--y", "3"], "CU-VAL-003"],
    [["click", "--shot", "1", "--x", "5", "--y", "3", "--button", "back"], "CU-VAL-003"],
    [["click", "--shot", "1", "--x", "5", "--y", "3", "--count", "4"], "CU-VAL-003"],
    [["click", "--ref", "1"], "CU-VAL-004"],
    [["screenshot", "--window", "1", "--max-size", "100"], "CU-VAL-003"],
    [["drag", "--shot", "1", "--from", "10,20"], "CU-VAL-002"],
    [["drag", "--shot", "1", "--from", "10", "--to", "3,4"], "CU-VAL-003"],
    [["drag", "--shot", "1", "--from", "10,20,30", "--to", "3,4"], "CU-VAL-003"],
    [["drag", "--shot", "1", "--from", "a,b", "--to", "3,4"], "CU-VAL-003"],
    [["drag", "--shot", "1", "--from", "-1,2", "--to", "3,4"], "CU-VAL-003"],
    [["scroll", "--ref", "1", "--shot", "2", "--dy", "3"], "CU-VAL-004"],
    [["scroll", "--ref", "1", "--x", "4", "--dy", "3"], "CU-VAL-004"],
    [["scroll", "--shot", "2", "--x", "4", "--dy", "3"], "CU-VAL-002"],
    [["scroll", "--dy", "3"], "CU-VAL-002"],
    [["type", "--ref", "1", "--window", "2", "--text", "x"], "CU-VAL-004"],
    [["type", "--text", "x"], "CU-VAL-002"],
    [["move", "--shot", "1", "--x", "1", "--y", "2", "--button", "left"], "CU-VAL-004"],
  ])("%j fails with %s and sends nothing", async (argv, code) => {
    const server = await startServer({ body: OK_INPUT });
    const result = await run(argv, { endpoint: server.unixEndpoint });
    expect(result.code).toBe(1);
    expect(outputOf(result.stdout)).toMatchObject({ ok: false, error: { code } });
    expect(server.seen).toHaveLength(0);
  });

  it("builds requests the contract schema accepts", async () => {
    const cases: ReadonlyArray<readonly [ReadonlyArray<string>, unknown]> = [
      [["status"], { command: "status" }],
      [["list-windows", "--app", "Safari"], { command: "list-windows", app: "Safari" }],
      [
        ["observe", "--window=3", "--query", "Save"],
        { command: "observe", window: 3, query: "Save" },
      ],
      [["screenshot", "--window", "2"], { command: "screenshot", window: 2 }],
      [["press", "--ref", "7"], { command: "press", ref: 7 }],
      [
        ["set-value", "--ref", "7", "--value", "--x"],
        { command: "set-value", ref: 7, value: "--x" },
      ],
      [["type", "--ref", "7", "--text", "hi"], { command: "type", ref: 7, text: "hi" }],
      [
        ["key", "--window", "1", "--keys", "Cmd+Shift+Z"],
        { command: "key", window: 1, keys: "cmd+shift+z" },
      ],
      [["scroll", "--ref", "4", "--dy", "-3"], { command: "scroll", ref: 4, dx: 0, dy: -3 }],
      [
        ["screenshot", "--window", "2", "--max-size", "2048"],
        { command: "screenshot", window: 2, maxSize: 2048 },
      ],
      [
        ["click", "--shot", "5", "--x", "0", "--y", "48", "--button", "right", "--count", "2"],
        { command: "click", shot: 5, x: 0, y: 48, button: "right", count: 2 },
      ],
      [
        ["click", "--shot", "5", "--x", "10", "--y", "48"],
        { command: "click", shot: 5, x: 10, y: 48 },
      ],
      [
        ["drag", "--shot", "5", "--from", "10,20", "--to=300, 40"],
        { command: "drag", shot: 5, fromX: 10, fromY: 20, toX: 300, toY: 40 },
      ],
      [["move", "--shot", "5", "--x", "7", "--y", "8"], { command: "move", shot: 5, x: 7, y: 8 }],
      [
        ["scroll", "--shot", "5", "--x", "7", "--y", "8", "--dx", "-2"],
        { command: "scroll-at", shot: 5, x: 7, y: 8, dx: -2, dy: 0 },
      ],
      [
        ["type", "--window", "3", "--text", "hello"],
        { command: "type-focused", window: 3, text: "hello" },
      ],
    ];
    for (const [argv, expected] of cases) {
      const parsed = await parseComputerArgs(argv, async () => "");
      expect(parsed).toEqual({ type: "request", request: expected });
      if (parsed.type === "request")
        expect(decodeContractRequest(parsed.request)).toEqual(expected);
    }
  });

  it("uses the contract's key chord grammar", () => {
    expect(CLI_KEY_PATTERN.source).toBe(COMPUTER_USE_KEY_PATTERN.source);
  });
});

describe("response validation agrees with ComputerUseResponse", () => {
  const samples: ReadonlyArray<unknown> = [
    { ok: true, result: { kind: "input", effect: "dispatched" } },
    { ok: true, result: { kind: "input", effect: "dispatched-unknown" } },
    {
      ok: true,
      result: {
        kind: "status",
        status: {
          mode: "control",
          platform: "darwin",
          driverAvailable: true,
          accessibility: "granted",
        },
      },
    },
    { ok: true, result: { kind: "status", status: { mode: "on" } } },
    {
      ok: true,
      result: {
        kind: "windows",
        windows: [
          {
            id: 1,
            app: "Safari",
            pid: 9,
            title: "x",
            focused: true,
            bounds: { x: 0, y: 0, width: 1, height: 2 },
          },
        ],
      },
    },
    {
      ok: true,
      result: {
        kind: "windows",
        windows: [{ id: 0, app: "a", pid: 1, title: "", focused: false }],
      },
    },
    {
      ok: true,
      result: {
        kind: "observation",
        window: 2,
        truncated: false,
        elements: [{ ref: 4, role: "button", label: "OK", enabled: true, focused: false }],
      },
    },
    {
      ok: true,
      result: {
        kind: "observation",
        window: 2,
        truncated: false,
        elements: [
          { ref: 4, role: "button", label: "OK", value: 3, enabled: true, focused: false },
        ],
      },
    },
    {
      ok: true,
      result: { kind: "screenshot", window: 1, path: "/tmp/a.png", width: 10, height: 20 },
    },
    {
      ok: true,
      result: {
        kind: "screenshot",
        shot: 2,
        window: 1,
        path: "/tmp/a.png",
        width: 1.5,
        height: 20,
      },
    },
    {
      ok: true,
      result: { kind: "screenshot", shot: 3, window: 1, path: "/tmp/a.png", width: 10, height: 20 },
    },
    {
      ok: true,
      result: {
        kind: "input",
        effect: "dispatched",
        screenshot: { shot: 4, window: 1, path: "/tmp/b.png", width: 10, height: 20 },
      },
    },
    {
      ok: true,
      result: { kind: "input", effect: "dispatched", screenshot: { shot: 0, window: 1 } },
    },
    { ok: false, error: { code: "CU-CON-007", message: "take a new screenshot" } },
    { ok: false, error: { code: "CU-NOT-003", message: "unknown shot" } },
    { ok: false, error: { code: "CU-CON-003", message: "observe again" } },
    { ok: false, error: { code: "CU-CON-004", message: "declined", effect: "not-dispatched" } },
    { ok: false, error: { code: "CU-CON-009", message: "x" } },
    { ok: false, error: { code: "CU-EXT-004", message: "x", effect: "maybe" } },
    { ok: true },
    { ok: "true", result: { kind: "input", effect: "dispatched" } },
    null,
    [],
  ];
  it.each(samples.map((sample) => [JSON.stringify(sample), sample]))("%s", (_name, sample) => {
    expect(isComputerUseResponse(sample)).toBe(isContractResponse(sample));
  });
});

describe("transport", () => {
  it("refuses outside a computer-use session", async () => {
    const result = await run(["status"]);
    expect(result.code).toBe(1);
    expect(outputOf(result.stdout)).toMatchObject({ ok: false, error: { code: "CU-CON-001" } });
  });

  it("prints the manual without a session", async () => {
    const result = await run(["help"]);
    expect(result).toEqual({ code: 0, stdout: COMPUTER_CLI_MANUAL });
  });

  it("reports an unreachable server as CU-EXT-006", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-computer-cli-"));
    cleanups.push(async () => NodeFS.rmSync(directory, { recursive: true, force: true }));
    const missingSocket = await run(["status"], {
      endpoint: `unix:${NodePath.join(directory, "missing.sock")}`,
    });
    expect(outputOf(missingSocket.stdout)).toMatchObject({ error: { code: "CU-EXT-006" } });

    const closed = await listen(NodeHttp.createServer(), 0);
    const port = (closed.address() as NodeNet.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    const refused = await run(["status"], {
      endpoint: `http://127.0.0.1:${port}/api/computer-use`,
    });
    expect(refused.code).toBe(1);
    expect(outputOf(refused.stdout)).toMatchObject({ error: { code: "CU-EXT-006" } });
  });

  it.each([
    ["non-JSON", "<html>oops</html>"],
    ["schema-invalid", JSON.stringify({ ok: true, result: { kind: "input", effect: "maybe" } })],
  ])("reports a %s reply as CU-EXT-005", async (_name, body) => {
    const server = await startServer({ body });
    const result = await run(["press", "--ref", "1"], { endpoint: server.unixEndpoint });
    expect(result.code).toBe(1);
    expect(outputOf(result.stdout)).toEqual({
      ok: false,
      error: { code: "CU-EXT-005", message: expect.any(String) },
    });
  });

  it("passes a valid ok reply through with exit 0, over a unix socket", async () => {
    const server = await startServer({ body: OK_INPUT });
    const result = await run(["press", "--ref", "12"], { endpoint: server.unixEndpoint });
    expect(result).toEqual({ code: 0, stdout: `${OK_INPUT}\n` });
    expect(server.seen).toEqual([
      expect.objectContaining({
        url: "/api/computer-use",
        body: JSON.stringify({ command: "press", ref: 12 }),
        headers: expect.objectContaining({ authorization: "Bearer test" }),
      }),
    ]);
  });

  it("passes a valid error reply through with a non-zero exit, over http", async () => {
    const body = JSON.stringify({
      ok: false,
      error: { code: "CU-CON-004", message: "The user declined.", effect: "not-dispatched" },
    });
    const server = await startServer({ body });
    const result = await run(["press", "--ref", "12"], { endpoint: server.httpEndpoint });
    expect(result).toEqual({ code: 1, stdout: `${body}\n` });
    expect(server.seen[0]?.url).toBe("/api/computer-use");
  });

  it("maps a rejected credential to CU-CON-001", async () => {
    const server = await startServer({ status: 401, body: "unauthorized" });
    const result = await run(["status"], { endpoint: server.unixEndpoint });
    expect(outputOf(result.stdout)).toMatchObject({ error: { code: "CU-CON-001" } });
  });

  it("reads --text - from stdin without its trailing newline", async () => {
    const server = await startServer({ body: OK_INPUT });
    const result = await run(["type", "--ref", "3", "--text", "-"], {
      endpoint: server.unixEndpoint,
      stdin: "line one\nline two\n",
    });
    expect(result.code).toBe(0);
    expect(JSON.parse(server.seen[0]?.body ?? "")).toEqual({
      command: "type",
      ref: 3,
      text: "line one\nline two",
    });
  });
});

describe("Computer use CLI audit regressions", () => {
  it("accepts the CU-CON-008 response", () => {
    expect(
      isComputerUseResponse({
        ok: false,
        error: { code: "CU-CON-008", message: "Paused", effect: "not-dispatched" },
      }),
    ).toBe(true);
  });
  it("does not echo a split typed argument into its error output", async () => {
    const r = await parseComputerArgs(
      ["type", "--ref", "1", "--text", "secret", "typed-value-tail"],
      async () => "",
    );
    expect(JSON.stringify(r)).not.toContain("typed-value-tail");
  });
  it("preserves pending-approval refusal through the CLI", async () => {
    const server = NodeHttp.createServer((_req, res) =>
      res.end(
        JSON.stringify({
          ok: false,
          error: { code: "CU-CON-008", message: "Paused", effect: "not-dispatched" },
        }),
      ),
    );
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const addr = server.address();
      if (!addr || typeof addr === "string") throw new Error("address");
      let output = "";
      const exit = await runComputerCli({
        argv: ["key", "--window", "1", "--keys", "enter"],
        env: {
          VIEWCODE_COMPUTER_ENDPOINT: `http://127.0.0.1:${addr.port}/api/computer-use`,
          VIEWCODE_COMPUTER_AUTH: "Bearer audit",
        },
        readStdin: async () => "",
        writeStdout: (s) => (output += s),
      });
      expect(exit).toBe(1);
      expect(JSON.parse(output).error.code).toBe("CU-CON-008");
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((e) => (e ? reject(e) : resolve())),
      );
    }
  });
});
