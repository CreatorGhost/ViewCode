import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import { HTML_RENDER_ACTIVITY_KIND } from "@t3tools/shared/htmlRender";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { resolveAttachmentPathById } from "../../../attachmentStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlToolkitHandlersLive } from "./handlers.ts";
import { HtmlToolkit } from "./tools.ts";

const THREAD_ID = ThreadId.make("thread-html");
const TURN_ID = TurnId.make("turn-html");

let uuidCounter = 0;
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(++uuidCounter % 256),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

// Only the field the handler reads: the running turn the page belongs to.
const runningThread = {
  id: THREAD_ID,
  session: { activeTurnId: TURN_ID },
} as unknown as OrchestrationThreadShell;

const makeHarness = Effect.fn("makeHtmlToolkitHarness")(function* (
  options: { readonly reject?: boolean } = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    options.reject
      ? Effect.fail(
          new OrchestrationCommandInvariantError({ commandType: command.type, detail: "gone" }),
        )
      : Ref.update(commands, (recorded) => [...recorded, command]).pipe(Effect.as({ sequence: 1 }));
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: () => Effect.succeedSome(runningThread),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    HtmlRender.layer,
  ).pipe(
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-mcp-html-" })),
    Layer.provideMerge(NodeServices.layer),
  );
  const context = yield* Layer.build(dependencies);
  const toolkit = yield* HtmlToolkit.pipe(
    Effect.provide(HtmlToolkitHandlersLive),
    Effect.provideContext(context),
  );
  const call = (
    params: Parameters<typeof toolkit.handle<"html_render">>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["html"],
  ) =>
    toolkit.handle("html_render", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof HtmlToolkit.tools)["html_render"]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provideContext(context),
    );
  const storedPages = Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const names = yield* fileSystem
      .readDirectory(config.attachmentsDir)
      .pipe(Effect.orElseSucceed(() => []));
    return names.filter((name) => name.endsWith(".html"));
  }).pipe(Effect.provideContext(context));
  return { commands, call, storedPages, context };
});

describe("html toolkit handlers", () => {
  it.effect("publishes the page and appends an html.render activity on the running turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({
        html: "<p>Revenue</p>",
        title: "Revenue",
        height: 240,
      });

      expect(result.htmlRender).toEqual({
        attachmentId: expect.stringMatching(/^thread-html-.+-html$/),
        title: "Revenue",
        height: 240,
      });
      const config = yield* ServerConfig.ServerConfig.pipe(Effect.provideContext(harness.context));
      const stored = resolveAttachmentPathById({
        attachmentsDir: config.attachmentsDir,
        attachmentId: result.htmlRender.attachmentId,
      });
      expect(stored).not.toBeNull();
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.activity.append",
          threadId: THREAD_ID,
          activity: {
            kind: HTML_RENDER_ACTIVITY_KIND,
            summary: "Revenue",
            turnId: TURN_ID,
            payload: result.htmlRender,
          },
        },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("refuses a credential without the html capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call({ html: "<p>x</p>", title: "X", height: 200 }, ["agents"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "McpCapabilityUnavailableError", capability: "html" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
      expect(yield* harness.storedPages).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("removes the page when its activity cannot be recorded", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ reject: true });
      const error = yield* harness
        .call({ html: "<p>x</p>", title: "X", height: 200 })
        .pipe(Effect.flip);
      expect(error).toBeInstanceOf(HtmlRender.HtmlRenderStoreError);
      expect(yield* harness.storedPages).toEqual([]);
    }).pipe(Effect.scoped),
  );
});
