import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { GoalToolkit } from "./tools.ts";

// Registering a toolkit builds each tool's MCP input schema at server start; a tool whose
// parameters do not yield an object schema stops the whole server, so register it for real.
const Handlers = GoalToolkit.toLayer({
  viewcode_get_goal: () => Effect.die("unused"),
  viewcode_set_goal: () => Effect.die("unused"),
});

const TestLayer = McpServer.toolkit(GoalToolkit).pipe(
  Layer.provide(Handlers),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers the goal tools on an MCP server", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => tool);
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "viewcode_get_goal",
      "viewcode_set_goal",
    ]);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  }).pipe(Effect.provide(TestLayer)),
);
