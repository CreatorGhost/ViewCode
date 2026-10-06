import { CommandId, EventId } from "@t3tools/contracts";
import { HTML_RENDER_ACTIVITY_KIND } from "@t3tools/shared/htmlRender";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HtmlToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const htmlRender = yield* HtmlRender.HtmlRender;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  return HtmlToolkit.of({
    html_render: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* McpInvocationContext.requireMcpCapability("html");
        const { reference, filePath } = yield* htmlRender.publish({ threadId, ...input });
        // Provider adapters do not reliably carry MCP tool results into the
        // thread, so the page reaches clients as an activity of its own. It
        // belongs to the running turn, so reverting that turn removes it.
        yield* Effect.gen(function* () {
          const thread = yield* snapshots.getThreadShellById(threadId);
          const turnId = Option.match(thread, {
            onNone: () => null,
            onSome: (shell) => shell.session?.activeTurnId ?? null,
          });
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          yield* engine.dispatch({
            type: "thread.activity.append",
            commandId: CommandId.make(`server:html-render:${threadId}:${yield* uuid}`),
            threadId,
            activity: {
              id: EventId.make(yield* uuid),
              tone: "info",
              kind: HTML_RENDER_ACTIVITY_KIND,
              summary: reference.title,
              payload: reference,
              turnId,
              createdAt,
            },
            createdAt,
          });
        }).pipe(
          Effect.mapError((cause) => new HtmlRender.HtmlRenderStoreError({ cause })),
          // Nothing references a page whose activity never landed.
          Effect.onError(() => fileSystem.remove(filePath, { force: true }).pipe(Effect.ignore)),
        );
        return {
          htmlRender: reference,
          message:
            "Shown to the reader above your reply. Don't mention or describe the page; reply with only what it doesn't already say.",
        };
      }),
  });
});

export const HtmlToolkitHandlersLive = HtmlToolkit.toLayer(make);
