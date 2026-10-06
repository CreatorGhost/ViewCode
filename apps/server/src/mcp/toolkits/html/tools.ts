import { McpCapabilityUnavailableError } from "@t3tools/contracts";
import {
  HTML_RENDER_LAYOUT_GUIDE,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_THEME_GUIDE,
  HTML_RENDER_TOOL_NAME,
} from "@t3tools/shared/htmlRender";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import * as HtmlRender from "../../../htmlRender/HtmlRender.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const HtmlRenderToolError = Schema.Union([
  McpCapabilityUnavailableError,
  HtmlRender.HtmlRenderImagesNotFoundError,
  HtmlRender.HtmlRenderImageTooLargeError,
  HtmlRender.HtmlRenderPageTooLargeError,
  HtmlRender.HtmlRenderStoreError,
]);

const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote http(s) URLs, such as a CDN chart library, load as-is.';

// Read-only in the MCP sense: it shows a page in the caller's own thread and
// touches no workspace, so plan mode and read-only sandboxes can use it.
// Open-world, since the page may load remote resources.
const HtmlRenderTool = Tool.make(HTML_RENDER_TOOL_NAME, {
  description: `Show a finished HTML page (chart, table, diagram, collage, mockup) inline in this thread, above your final text reply; call it before writing that reply. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page doesn't say. The frame starts at height and then fits the page's own content height, up to ${HTML_RENDER_MAX_HEIGHT}px; anything taller scrolls inside the frame. ${PAGE_RULES} ${HTML_RENDER_LAYOUT_GUIDE} ${HTML_RENDER_THEME_GUIDE}`,
  parameters: Schema.Struct({
    html: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512_000)).annotate({
      description: "A complete, self-contained HTML document.",
    }),
    title: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(HTML_RENDER_MAX_TITLE_LENGTH),
    ).annotate({ description: "Short name for the page." }),
    height: Schema.Int.annotate({
      description: `Your best estimate of the page's height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. The frame shows at this height while the page loads.`,
    }),
  }),
  success: Schema.Struct({
    htmlRender: Schema.Struct({
      attachmentId: Schema.String,
      title: Schema.String,
      height: Schema.Number,
    }),
    message: Schema.String,
  }),
  failure: HtmlRenderToolError,
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "Render HTML")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true);

export const HtmlToolkit = Toolkit.make(HtmlRenderTool);
