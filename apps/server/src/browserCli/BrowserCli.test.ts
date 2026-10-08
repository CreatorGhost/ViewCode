// @effect-diagnostics nodeBuiltinImport:off - exercises the plain-Node CLI against real local HTTP servers.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { BROWSER_CLI_MANUAL, parseBrowserArgs, runBrowserCli } from "./BrowserCli.ts";
import { BROWSER_CLI_TOOLS } from "./browserCliProtocol.ts";

const noStdin = async () => {
  throw new Error("stdin should not be read");
};

const parse = (argv: ReadonlyArray<string>, stdin: () => Promise<string> = noStdin) =>
  parseBrowserArgs(argv, stdin);

describe("parseBrowserArgs", () => {
  it.each([
    [["status"], { tool: "preview_status", input: {} }],
    [
      ["open", "--url", "https://example.com", "--background", "--new-tab"],
      {
        tool: "preview_open",
        input: { url: "https://example.com", open: false, reuseExistingTab: false },
      },
    ],
    [
      ["navigate", "--port", "5173", "--path", "/settings", "--https", "--wait", "none"],
      {
        tool: "preview_navigate",
        input: {
          target: { kind: "environment-port", port: 5173, protocol: "https", path: "/settings" },
          readiness: "none",
        },
      },
    ],
    [["snapshot", "--no-image"], { tool: "preview_snapshot", input: { includeImage: false } }],
    [
      ["click", "--locator", "role=button[name='Send']", "--tab", "tab-2"],
      { tool: "preview_click", input: { tabId: "tab-2", locator: "role=button[name='Send']" } },
    ],
    [["click", "--x", "10", "--y", "20"], { tool: "preview_click", input: { x: 10, y: 20 } }],
    [
      ["press", "--key", "a", "--modifiers", "Meta, Shift"],
      { tool: "preview_press", input: { key: "a", modifiers: ["Meta", "Shift"] } },
    ],
    [["scroll", "--dy", "400"], { tool: "preview_scroll", input: { deltaY: 400 } }],
    [
      ["wait-for", "--text", "Done", "--url-includes", "/ok", "--timeout", "5000"],
      { tool: "preview_wait_for", input: { text: "Done", urlIncludes: "/ok", timeoutMs: 5000 } },
    ],
    [
      ["resize", "--mode", "freeform", "--width", "390", "--height", "844"],
      { tool: "preview_resize", input: { mode: "freeform", width: 390, height: 844 } },
    ],
    [
      ["appearance", "--scheme", "dark"],
      { tool: "preview_set_appearance", input: { colorScheme: "dark" } },
    ],
    [["record-stop"], { tool: "preview_recording_stop", input: {} }],
  ])("%j", async (argv, request) => {
    expect(await parse(argv)).toEqual({ type: "request", request });
  });

  it("reads --text - and --expression - from stdin without its trailing newline", async () => {
    expect(
      await parse(["type", "--selector", "input", "--text", "-", "--clear"], async () => "hi\n"),
    ).toEqual({
      type: "request",
      request: { tool: "preview_type", input: { selector: "input", text: "hi", clear: true } },
    });
    expect(await parse(["eval", "--expression", "-"], async () => "document.title\n")).toEqual({
      type: "request",
      request: { tool: "preview_evaluate", input: { expression: "document.title" } },
    });
  });

  it.each([
    [["fly"], "Unknown command"],
    [["click", "--window", "1"], "does not take --window"],
    [["click", "--x"], "needs a value"],
    [["click", "--x", "ten", "--y", "1"], "must be a number"],
    [["status", "extra"], "Unexpected argument"],
    [["status", "--tab", "a", "--tab", "b"], "given twice"],
  ])("refuses %j", async (argv, message) => {
    expect(await parse(argv)).toMatchObject({
      type: "error",
      error: { code: "usage", message: expect.stringContaining(message) },
    });
  });

  it("covers every preview tool", async () => {
    const tools = new Set<string>();
    for (const command of [
      "status",
      "open",
      "navigate",
      "resize",
      "appearance",
      "snapshot",
      "click",
      "type",
      "press",
      "scroll",
      "eval",
      "wait-for",
      "record-start",
      "record-stop",
    ]) {
      const parsed = await parse([command]);
      if (parsed.type === "request") tools.add(parsed.request.tool);
    }
    expect([...tools].toSorted()).toEqual([...BROWSER_CLI_TOOLS].toSorted());
  });
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const serve = async (reply: { readonly status?: number; readonly body: string }) => {
  const seen: Array<{ url: string; authorization: string | undefined; body: string }> = [];
  const handler: NodeHttp.RequestListener = (request, response) => {
    let body = "";
    request.on("data", (chunk) => (body += chunk));
    request.on("end", () => {
      seen.push({ url: request.url ?? "", authorization: request.headers.authorization, body });
      response.writeHead(reply.status ?? 200, { "content-type": "application/json" });
      response.end(reply.body);
    });
  };
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-browser-cli-"));
  const socketPath = NodePath.join(directory, "server.sock");
  const unixServer = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));
  const tcpServer = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const port = (tcpServer.address() as { port: number }).port;
  cleanups.push(async () => {
    await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
    NodeFS.rmSync(directory, { recursive: true, force: true });
  });
  return {
    seen,
    unixEndpoint: `unix:${socketPath}`,
    httpEndpoint: `http://127.0.0.1:${port}/api/browser`,
  };
};

const run = async (argv: ReadonlyArray<string>, env: NodeJS.ProcessEnv = {}) => {
  let stdout = "";
  const code = await runBrowserCli({
    argv,
    env,
    readStdin: noStdin,
    writeStdout: (text) => (stdout += text),
  });
  return { code, stdout, output: stdout.startsWith("{") ? JSON.parse(stdout) : undefined };
};

describe("runBrowserCli", () => {
  it("prints the manual without a session", async () => {
    expect(await run(["help"])).toMatchObject({ code: 0, stdout: BROWSER_CLI_MANUAL });
  });

  it("refuses outside a ViewCode session with browser access", async () => {
    expect(await run(["status"])).toMatchObject({
      code: 1,
      output: { ok: false, error: { code: "unavailable" } },
    });
  });

  it("posts one tool call with the session credential, over a unix socket and http", async () => {
    const body = JSON.stringify({ ok: true, result: { available: true } });
    const server = await serve({ body });
    for (const endpoint of [server.unixEndpoint, server.httpEndpoint]) {
      const result = await run(["status", "--tab", "tab-1"], {
        VIEWCODE_BROWSER_ENDPOINT: endpoint,
        VIEWCODE_BROWSER_AUTH: "Bearer secret",
      });
      expect(result).toEqual({ code: 0, stdout: `${body}\n`, output: JSON.parse(body) });
    }
    expect(server.seen).toEqual([
      {
        url: "/api/browser",
        authorization: "Bearer secret",
        body: JSON.stringify({ tool: "preview_status", input: { tabId: "tab-1" } }),
      },
      {
        url: "/api/browser",
        authorization: "Bearer secret",
        body: JSON.stringify({ tool: "preview_status", input: { tabId: "tab-1" } }),
      },
    ]);
  });

  it.each([
    [{ status: 401, body: "{}" }, "credential"],
    [{ status: 404, body: "Not Found" }, "unreachable"],
    [{ status: 200, body: "<html>" }, "invalid-reply"],
  ])("maps a %j reply to %s", async (reply, code) => {
    const server = await serve(reply);
    expect(
      await run(["status"], {
        VIEWCODE_BROWSER_ENDPOINT: server.httpEndpoint,
        VIEWCODE_BROWSER_AUTH: "Bearer secret",
      }),
    ).toMatchObject({ code: 1, output: { ok: false, error: { code } } });
  });

  it("passes a browser error through with a non-zero exit", async () => {
    const body = JSON.stringify({
      ok: false,
      error: { code: "PreviewAutomationNoAvailableHostError", message: "Open the desktop app." },
    });
    const server = await serve({ body });
    expect(
      await run(["status"], {
        VIEWCODE_BROWSER_ENDPOINT: server.httpEndpoint,
        VIEWCODE_BROWSER_AUTH: "Bearer secret",
      }),
    ).toEqual({ code: 1, stdout: `${body}\n`, output: JSON.parse(body) });
  });

  it("reports an unreachable server", async () => {
    expect(
      await run(["status"], {
        VIEWCODE_BROWSER_ENDPOINT: "unix:/nonexistent/viewcode.sock",
        VIEWCODE_BROWSER_AUTH: "Bearer secret",
      }),
    ).toMatchObject({ code: 1, output: { error: { code: "unreachable" } } });
  });
});
