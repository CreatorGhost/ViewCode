import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/unstable/ai";

import { HistoryToolkit } from "./tools.ts";

// Registering a toolkit builds each tool's MCP input schema at server start; a tool whose
// parameters do not yield an object schema stops the whole server, so register it for real.
const Handlers = HistoryToolkit.toLayer({
  viewcode_scan_importable_projects: () => Effect.die("unused"),
  viewcode_list_importable_sessions: () => Effect.die("unused"),
  viewcode_import_sessions: () => Effect.die("unused"),
});

const TestLayer = McpServer.toolkit(HistoryToolkit).pipe(
  Layer.provide(Handlers),
  Layer.provideMerge(McpServer.McpServer.layer),
);

it.effect("registers the history import tools on an MCP server", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => tool);
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "viewcode_import_sessions",
      "viewcode_list_importable_sessions",
      "viewcode_scan_importable_projects",
    ]);
    for (const tool of tools) expect(tool.inputSchema).toMatchObject({ type: "object" });
  }).pipe(Effect.provide(TestLayer)),
);
