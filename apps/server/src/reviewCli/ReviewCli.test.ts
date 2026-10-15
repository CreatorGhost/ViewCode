// @effect-diagnostics nodeBuiltinImport:off - exercises the plain-Node CLI against real local HTTP servers.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { REVIEW_CLI_MANUAL, parseReviewArgs, runReviewCli } from "./ReviewCli.ts";

const findings = { verdict: "approve", mergeConfidence: 5, reviewEffort: 1, findings: [] };

const noStdin = async () => {
  throw new Error("stdin should not be read");
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

const tempDir = () => {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-review-cli-"));
  cleanups.push(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
  return directory;
};

describe("parseReviewArgs", () => {
  it("reads the findings from stdin, or from --file", async () => {
    const text = JSON.stringify(findings);
    expect(await parseReviewArgs(["submit"], async () => `${text}\n`)).toEqual({
      type: "submit",
      body: text,
    });
    const file = NodePath.join(tempDir(), "findings.json");
    NodeFS.writeFileSync(file, text);
    expect(await parseReviewArgs(["submit", "--file", file], noStdin)).toEqual({
      type: "submit",
      body: text,
    });
  });

  it.each([
    [["fly"], noStdin, "Unknown command"],
    [["submit", "--json"], noStdin, "does not take --json"],
    [["submit", "--file"], noStdin, "needs a path"],
    [["submit", "--file", "/nonexistent/findings.json"], noStdin, "Could not read"],
    [["submit"], async () => "  \n", "No findings were given"],
    [["submit"], async () => "{verdict:", "not valid JSON"],
    [["submit"], async () => "[]", "one JSON object"],
  ])("refuses %j", async (argv, readStdin, message) => {
    expect(await parseReviewArgs(argv, readStdin)).toMatchObject({
      type: "error",
      error: { code: "usage", message: expect.stringContaining(message) },
    });
  });
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
  const socketPath = NodePath.join(tempDir(), "server.sock");
  const unixServer = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => unixServer.listen(socketPath, resolve));
  const tcpServer = NodeHttp.createServer(handler);
  await new Promise<void>((resolve) => tcpServer.listen(0, "127.0.0.1", resolve));
  const port = (tcpServer.address() as { port: number }).port;
  cleanups.unshift(async () => {
    await new Promise<void>((resolve) => unixServer.close(() => resolve()));
    await new Promise<void>((resolve) => tcpServer.close(() => resolve()));
  });
  return {
    seen,
    unixEndpoint: `unix:${socketPath}`,
    httpEndpoint: `http://127.0.0.1:${port}/api/review-findings`,
  };
};

const run = async (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv = {},
  stdin = JSON.stringify(findings),
) => {
  let stdout = "";
  const code = await runReviewCli({
    argv,
    env,
    readStdin: async () => stdin,
    writeStdout: (text) => (stdout += text),
  });
  return { code, stdout, output: stdout.startsWith("{") ? JSON.parse(stdout) : undefined };
};

describe("runReviewCli", () => {
  it("prints the manual without a session", async () => {
    expect(await run(["help"])).toMatchObject({ code: 0, stdout: REVIEW_CLI_MANUAL });
  });

  it("refuses outside a ViewCode session", async () => {
    expect(await run(["submit"])).toMatchObject({
      code: 1,
      output: { ok: false, error: { code: "unavailable" } },
    });
  });

  it("posts what it read with the session credential, over a unix socket and http", async () => {
    const body = JSON.stringify({ ok: true, result: { target: "local", findings: 0 } });
    const server = await serve({ body });
    for (const endpoint of [server.unixEndpoint, server.httpEndpoint]) {
      const result = await run(["submit"], {
        VIEWCODE_REVIEW_ENDPOINT: endpoint,
        VIEWCODE_REVIEW_AUTH: "Bearer secret",
      });
      expect(result).toEqual({ code: 0, stdout: `${body}\n`, output: JSON.parse(body) });
    }
    const expected = {
      url: "/api/review-findings",
      authorization: "Bearer secret",
      body: JSON.stringify(findings),
    };
    expect(server.seen).toEqual([expected, expected]);
  });

  it.each([
    [{ status: 401, body: "{}" }, "credential"],
    [{ status: 404, body: "Not Found" }, "unreachable"],
    [{ status: 200, body: "<html>" }, "invalid-reply"],
  ])("maps a %j reply to %s", async (reply, code) => {
    const server = await serve(reply);
    expect(
      await run(["submit"], {
        VIEWCODE_REVIEW_ENDPOINT: server.httpEndpoint,
        VIEWCODE_REVIEW_AUTH: "Bearer secret",
      }),
    ).toMatchObject({ code: 1, output: { ok: false, error: { code } } });
  });

  it("passes the server's refusal through with a non-zero exit", async () => {
    const body = JSON.stringify({
      ok: false,
      error: { code: "usage", message: "Invalid findings: verdict is wrong." },
    });
    const server = await serve({ body });
    expect(
      await run(["submit"], {
        VIEWCODE_REVIEW_ENDPOINT: server.httpEndpoint,
        VIEWCODE_REVIEW_AUTH: "Bearer secret",
      }),
    ).toEqual({ code: 1, stdout: `${body}\n`, output: JSON.parse(body) });
  });

  it("reports an unreachable server", async () => {
    expect(
      await run(["submit"], {
        VIEWCODE_REVIEW_ENDPOINT: "unix:/nonexistent/viewcode.sock",
        VIEWCODE_REVIEW_AUTH: "Bearer secret",
      }),
    ).toMatchObject({ code: 1, output: { error: { code: "unreachable" } } });
  });
});
