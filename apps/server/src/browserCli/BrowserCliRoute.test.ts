// @effect-diagnostics preferSchemaOverJson:off - asserts on the raw JSON the route writes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewAutomationNoAvailableHostError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { browserCliRouteLayer } from "./BrowserCliRoute.ts";

const credentialThread = ThreadId.make("thread-from-credential");

const scope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: credentialThread,
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("claude"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

// A 1x1 transparent PNG.
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const snapshot = {
  url: "https://example.com/page",
  title: "Example",
  loading: false,
  visibleText: "Hello",
  interactiveElements: [{ name: "Send", role: "button", locator: "role=button[name='Send']" }],
  accessibilityTree: { role: "WebArea" },
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: PNG_BASE64, width: 1, height: 1 },
};

type Invocation = PreviewAutomationBroker.PreviewAutomationInvokeInput;

const serve = (options: { readonly noHost?: boolean } = {}) =>
  Effect.gen(function* () {
    const invoked: Array<Invocation> = [];
    const routes = browserCliRouteLayer.pipe(
      Layer.provide(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          resolve: (token) =>
            Effect.succeed(
              token === "with-browser"
                ? scope(["agents", "preview"])
                : token === "without-browser"
                  ? scope(["agents"])
                  : undefined,
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(PreviewAutomationBroker.PreviewAutomationBroker)({
          invoke: (input) =>
            Effect.suspend(() => {
              invoked.push(input);
              if (options.noHost) {
                return Effect.fail(
                  new PreviewAutomationNoAvailableHostError({
                    operation: input.operation,
                    environmentId: input.scope.environmentId,
                    threadId: input.scope.threadId,
                    providerSessionId: input.scope.providerSessionId,
                    providerInstanceId: input.scope.providerInstanceId,
                  }),
                );
              }
              const result =
                input.operation === "snapshot"
                  ? snapshot
                  : input.operation === "status"
                    ? { available: true, visible: true, tabId: "tab-1", url: snapshot.url }
                    : {};
              return Effect.succeed(result as never);
            }),
        }),
      ),
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-cli-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
      Layer.build,
    );
    return {
      client: yield* HttpClient.HttpClient,
      invoked,
    };
  });

const post = (client: HttpClient.HttpClient, authorization: string | undefined, body: unknown) =>
  client.post("/api/browser", {
    headers: authorization ? { authorization } : {},
    body: HttpBody.text(JSON.stringify(body), "application/json"),
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer)),
  );

it.effect("rejects a missing or unknown credential with 401", () =>
  run(
    Effect.gen(function* () {
      const { client, invoked } = yield* serve();
      const body = { tool: "preview_status", input: {} };
      expect((yield* post(client, undefined, body)).status).toBe(401);
      expect((yield* post(client, "Bearer forged", body)).status).toBe(401);
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("refuses a session without agent browser access, as the MCP tools do", () =>
  run(
    Effect.gen(function* () {
      const { client, invoked } = yield* serve();
      const response = yield* post(client, "Bearer without-browser", {
        tool: "preview_status",
        input: {},
      });
      expect(response.status).toBe(200);
      expect(yield* response.json).toMatchObject({
        ok: false,
        error: { code: "PreviewAutomationUnavailableError", message: expect.any(String) },
      });
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("drives the broker for the credential's thread, ignoring any thread in the body", () =>
  run(
    Effect.gen(function* () {
      const { client, invoked } = yield* serve();
      const response = yield* post(client, "Bearer with-browser", {
        tool: "preview_click",
        input: { locator: "role=button[name='Send']", tabId: "tab-9" },
        threadId: "someone-elses-thread",
      });
      expect(yield* response.json).toMatchObject({ ok: true });
      expect(invoked[0]).toMatchObject({
        operation: "click",
        input: { locator: "role=button[name='Send']" },
        tabId: "tab-9",
        scope: { threadId: credentialThread },
      });
    }),
  ),
);

it.effect("refuses invalid input and unknown tools before reaching the browser", () =>
  run(
    Effect.gen(function* () {
      const { client, invoked } = yield* serve();
      const noTarget = yield* post(client, "Bearer with-browser", {
        tool: "preview_click",
        input: {},
      });
      expect(yield* noTarget.json).toMatchObject({
        ok: false,
        error: { code: "usage", message: expect.stringContaining("click") },
      });
      const unknown = yield* post(client, "Bearer with-browser", {
        tool: "shell_exec",
        input: {},
      });
      expect(yield* unknown.json).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(invoked).toEqual([]);
    }),
  ),
);

it.effect("saves the snapshot PNG and returns its path instead of image data", () =>
  run(
    Effect.gen(function* () {
      const { client } = yield* serve();
      const fileSystem = yield* FileSystem.FileSystem;
      const response = yield* post(client, "Bearer with-browser", {
        tool: "preview_snapshot",
        input: {},
      });
      const body = (yield* response.json) as {
        ok: boolean;
        result: Record<string, unknown> & {
          screenshotPath: string;
          screenshot: Record<string, unknown>;
        };
      };
      expect(body.ok).toBe(true);
      expect(body.result.screenshotPath).toContain("browser-artifacts");
      expect(yield* fileSystem.exists(body.result.screenshotPath)).toBe(true);
      expect(body.result.screenshot).toEqual({ mimeType: "image/png", width: 1, height: 1 });
      expect(body.result).not.toHaveProperty("accessibilityTree");
      expect(JSON.stringify(body)).not.toContain(PNG_BASE64);

      const textOnly = (yield* (yield* post(client, "Bearer with-browser", {
        tool: "preview_snapshot",
        input: { includeImage: false },
      })).json) as { result: Record<string, unknown> };
      expect(textOnly.result).not.toHaveProperty("screenshotPath");
      expect(textOnly.result).toMatchObject({ url: snapshot.url, visibleText: "Hello" });
    }),
  ),
);

it.effect("passes the browser's own error and its guidance through", () =>
  run(
    Effect.gen(function* () {
      const { client } = yield* serve({ noHost: true });
      const response = yield* post(client, "Bearer with-browser", {
        tool: "preview_status",
        input: {},
      });
      expect(yield* response.json).toMatchObject({
        ok: false,
        error: {
          code: "PreviewAutomationNoAvailableHostError",
          message: expect.stringContaining("ViewCode desktop app"),
        },
      });
    }),
  ),
);
