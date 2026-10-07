import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpBody, HttpClient, HttpRouter } from "effect/unstable/http";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { computerUseRouteLayer } from "./ComputerUseRoute.ts";
import { ComputerUseService, type ComputerUseCaller } from "./ComputerUseService.ts";

const credentialThread = ThreadId.make("thread-from-credential");

const scope = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  threadId: credentialThread,
  providerSessionId: "provider-session",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const serve = Effect.gen(function* () {
  const handled: Array<{ readonly caller: ComputerUseCaller; readonly body: unknown }> = [];
  const routes = computerUseRouteLayer.pipe(
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) =>
          Effect.succeed(
            token === "with-computer"
              ? scope(["agents", "computer"])
              : token === "without-computer"
                ? scope(["agents"])
                : undefined,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ComputerUseService)({
        handle: (caller, body) =>
          Effect.sync(() => {
            handled.push({ caller, body });
            return { ok: true, result: { kind: "input", effect: "dispatched" } } as const;
          }),
      }),
    ),
  );
  yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  return { client: yield* HttpClient.HttpClient, handled };
});

const post = (client: HttpClient.HttpClient, authorization: string | undefined, body: unknown) =>
  client.post("/api/computer-use", {
    headers: authorization ? { authorization } : {},
    body: HttpBody.text(JSON.stringify(body), "application/json"),
  });

it.effect("rejects a missing or unknown credential with 401", () =>
  Effect.gen(function* () {
    const { client, handled } = yield* serve;
    expect((yield* post(client, undefined, { command: "status" })).status).toBe(401);
    expect((yield* post(client, "Bearer forged", { command: "status" })).status).toBe(401);
    expect(handled).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("refuses a credential that was not granted computer use", () =>
  Effect.gen(function* () {
    const { client, handled } = yield* serve;
    const response = yield* post(client, "Bearer without-computer", { command: "status" });
    expect(response.status).toBe(200);
    expect(yield* response.json).toMatchObject({ ok: false, error: { code: "CU-CON-001" } });
    expect(handled).toEqual([]);
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it.effect("acts for the credential's thread, whatever the body claims", () =>
  Effect.gen(function* () {
    const { client, handled } = yield* serve;
    const response = yield* post(client, "Bearer with-computer", {
      command: "status",
      threadId: "someone-elses-thread",
    });
    expect(response.status).toBe(200);
    expect(handled).toHaveLength(1);
    expect(handled[0]!.caller).toEqual({
      threadId: credentialThread,
      providerInstanceId: ProviderInstanceId.make("codex"),
    });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);
