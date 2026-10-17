import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";

// Build the actual production registration: malformed tool parameter schemas prevent startup.
const TestLayer = McpHttpServer.layerGoalToolkit.pipe(
  Layer.provide(
    Layer.mergeAll(Layer.mock(ThreadManagement.ThreadManagementService)({}), NodeCrypto.layer),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers ViewCode goal and debug tools through the production MCP access wrapper", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => tool);
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "viewcode_get_debug_mode",
      "viewcode_get_goal",
      "viewcode_set_debug_mode",
      "viewcode_set_goal",
    ]);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  }).pipe(Effect.provide(TestLayer)),
);
