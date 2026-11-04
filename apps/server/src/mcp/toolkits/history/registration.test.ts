import { expect, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpServer } from "effect/ai";
import * as Importer from "../../../project/AgentSessionImporter.ts";
import * as Scanner from "../../../project/AgentSessionScanner.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
const TestLayer = McpHttpServer.layerHistoryToolkit.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(Importer.AgentSessionImporter)({}),
      Layer.mock(Scanner.AgentSessionScanner)({}),
      Layer.mock(Threads.ThreadManagementService)({}),
      NodeCrypto.layer,
    ),
  ),
  Layer.provideMerge(McpServer.McpServer.layer),
);
it.effect("registers the native history import tools through production access declarations", () =>
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
