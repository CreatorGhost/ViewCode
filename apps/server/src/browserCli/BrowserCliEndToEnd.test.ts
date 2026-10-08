// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off - runs the real CLI as a child process against a real HTTP listener.
/**
 * End to end: the actual `viewcode-browser` CLI (a child process, started the
 * way the shim starts it) talks over a real unix socket or TCP port to the
 * real route, the real `McpSessionRegistry` credential check and the real
 * preview handlers. Only the browser host behind the broker is fake.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { NodeHttpServer } from "@effect/platform-node";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { browserCliRouteLayer } from "./BrowserCliRoute.ts";

const CLI_ENTRY = NodePath.join(import.meta.dirname, "..", "viewcode-browser.ts");
const TEST_TIMEOUT = 60_000;
const threadId = ThreadId.make("thread-browser-e2e");
const providerInstanceId = ProviderInstanceId.make("claudeAgent");

const makeStack = (listen: "unix" | "tcp") =>
  Effect.gen(function* () {
    const invoked: Array<PreviewAutomationBroker.PreviewAutomationInvokeInput> = [];
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-browser-e2e-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const listener =
      listen === "unix"
        ? NodeHttpServer.layer(() => NodeHttp.createServer(), {
            path: NodePath.join(directory, "server.sock"),
          })
        : NodeHttpServer.layer(() => NodeHttp.createServer(), { port: 0, host: "127.0.0.1" });
    const httpServer = Context.get(yield* Layer.build(listener), HttpServer.HttpServer);
    const registry = yield* McpSessionRegistry.__testing.make().pipe(
      Effect.provideService(HttpServer.HttpServer, httpServer),
      Effect.provideService(ServerEnvironment.ServerEnvironment, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("environment")),
        getDescriptor: Effect.die("unused"),
      }),
      Effect.provide(NodeServices.layer),
    );
    const broker = Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
      invoke: (input) =>
        Effect.sync(() => {
          invoked.push(input);
          return (
            input.operation === "status"
              ? { available: true, visible: true, tabId: "tab-1", url: "https://example.com/" }
              : {}
          ) as never;
        }),
    });
    yield* HttpRouter.serve(
      browserCliRouteLayer.pipe(
        Layer.provide(Layer.succeed(McpSessionRegistry.McpSessionRegistry, registry)),
        Layer.provide(broker),
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-e2e-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
      { disableListenLog: true, disableLogger: true },
    ).pipe(Layer.provide(Layer.succeed(HttpServer.HttpServer, httpServer)), Layer.build);

    const issue = (capabilities: ReadonlyArray<"preview" | "agents">) =>
      registry
        .issue({ threadId, providerInstanceId, capabilities: new Set(capabilities) })
        .pipe(Effect.map((issued) => issued.config));
    return { invoked, issue };
  });

const startCli = (
  config: { readonly browserEndpoint?: string; readonly authorizationHeader: string },
  argv: ReadonlyArray<string>,
) =>
  Effect.promise<{ code: number | null; json: any }>(
    () =>
      new Promise((resolve, reject) => {
        const child = NodeChildProcess.spawn(process.execPath, [CLI_ENTRY, ...argv], {
          env: {
            PATH: process.env.PATH ?? "",
            VIEWCODE_BROWSER_ENDPOINT: config.browserEndpoint ?? "",
            VIEWCODE_BROWSER_AUTH: config.authorizationHeader,
          },
          stdio: ["pipe", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          try {
            resolve({ code, json: JSON.parse(stdout) });
          } catch {
            reject(new Error(`CLI printed no JSON (exit ${code}): ${stdout}${stderr}`));
          }
        });
        child.stdin.end("");
      }),
  );

describe("viewcode-browser end to end", () => {
  for (const listen of ["unix", "tcp"] as const) {
    it.effect(
      `drives the browser for the credential's thread over ${listen}`,
      () =>
        Effect.gen(function* () {
          const stack = yield* makeStack(listen);
          const config = yield* stack.issue(["preview"]);
          expect(config.browserEndpoint?.startsWith(listen === "unix" ? "unix:" : "http://")).toBe(
            true,
          );

          const status = yield* startCli(config, ["status"]);
          expect(status).toMatchObject({ code: 0, json: { ok: true, result: { tabId: "tab-1" } } });

          const click = yield* startCli(config, ["click", "--locator", "text=Continue"]);
          expect(click).toMatchObject({ code: 0, json: { ok: true } });
          expect(stack.invoked.map((call) => call.operation)).toEqual([
            "status",
            "click",
            "status",
          ]);
          expect(stack.invoked[1]).toMatchObject({
            input: { locator: "text=Continue" },
            scope: { threadId },
          });
        }).pipe(Effect.scoped),
      TEST_TIMEOUT,
    );
  }

  it.effect(
    "a session without browser access gets the MCP tools' refusal, and nothing reaches the browser",
    () =>
      Effect.gen(function* () {
        const stack = yield* makeStack("tcp");
        const config = yield* stack.issue(["agents"]);
        const result = yield* startCli(config, ["status"]);
        expect(result).toMatchObject({
          code: 1,
          json: { ok: false, error: { code: "PreviewAutomationUnavailableError" } },
        });
        expect(stack.invoked).toEqual([]);

        const forged = yield* startCli({ ...config, authorizationHeader: "Bearer forged" }, [
          "status",
        ]);
        expect(forged).toMatchObject({ code: 1, json: { error: { code: "credential" } } });
      }).pipe(Effect.scoped),
    TEST_TIMEOUT,
  );
});
