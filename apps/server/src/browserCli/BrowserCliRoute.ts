/**
 * `POST /api/browser`: what the `viewcode-browser` CLI calls.
 *
 * It runs the MCP preview tools' own handlers, so the CLI drives the same
 * collaborative browser, with the same validation, gate and current tab, as
 * the `preview_*` tools. Authenticated with the provider session's MCP
 * credential (the CLI gets it as `VIEWCODE_BROWSER_AUTH`); the thread always
 * comes from that credential. Refusals answer 200 with `ok: false` so the CLI
 * can print them; only a bad credential is 401.
 */
import type { PreviewAutomationError } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import {
  boundSnapshotMetadata,
  saveScreenshot,
  type SnapshotMetadata,
} from "../mcp/McpHttpServer.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import { previewHandlers } from "../mcp/toolkits/preview/handlers.ts";
import { PreviewToolkit } from "../mcp/toolkits/preview/tools.ts";
import {
  BROWSER_CLI_ROUTE_PATH,
  BROWSER_CLI_TOOLS,
  type BrowserCliError,
  type BrowserCliResponse,
  type BrowserCliTool,
} from "./browserCliProtocol.ts";

/** Evaluated expressions are capped at 64k characters; leave room for JSON escaping. */
const MAX_BODY_BYTES = 256 * 1024;

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const noStore = { "cache-control": "no-store" };

const respond = (body: BrowserCliResponse, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });

const refuse = (code: string, message: string, status = 200) =>
  respond({ ok: false, error: { code, message } }, status);

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    ok: false,
    error: {
      code: "credential",
      message:
        "This browser credential is missing, unknown or expired. Ask the user to restart the agent session.",
    },
  },
  { status: 401, headers: { ...noStore, "www-authenticate": "Bearer" } },
);

class BrowserCliInvalidInput extends Data.TaggedError("BrowserCliInvalidInput")<{
  readonly message: string;
}> {}

class BodyTooLarge {
  readonly _tag = "BodyTooLarge";
}

const readBoundedBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.runForEach(request.stream, (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) return Effect.fail(new BodyTooLarge());
      chunks.push(chunk);
      return Effect.void;
    });
    return Buffer.concat(chunks).toString("utf8");
  });

const isTool = (value: unknown): value is BrowserCliTool =>
  typeof value === "string" && (BROWSER_CLI_TOOLS as ReadonlyArray<string>).includes(value);

/**
 * The failure the agent sees. Preview errors build their message on the
 * server and say what to do next; anything else is named by its tag only.
 */
export const browserCliFailure = (cause: Cause.Cause<unknown>): BrowserCliError => {
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    if (tag === "BrowserCliInvalidInput") {
      return { code: "usage", message: String((error as { message?: unknown }).message) };
    }
    const message = (error as { message?: unknown }).message;
    return {
      code: tag,
      message: typeof message === "string" && message.length > 0 ? message : `${tag}.`,
    };
  }
  return { code: "internal", message: "The browser action failed unexpectedly." };
};

type Snapshot = SnapshotMetadata & {
  readonly screenshot: {
    readonly mimeType: string;
    readonly data: string;
    readonly width: number;
    readonly height: number;
  };
};

/**
 * Like the MCP snapshot, bounded near 20 KB with notes on what was cut, but a
 * shell cannot receive an image: the PNG is saved and its path returned,
 * unless the agent asked for text only.
 */
const snapshotResult = (snapshot: Snapshot, includeImage: boolean) =>
  Effect.gen(function* () {
    const { screenshot, ...page } = snapshot;
    const screenshotPath = includeImage
      ? yield* saveScreenshot(snapshot.url, new Uint8Array(Buffer.from(screenshot.data, "base64")))
      : undefined;
    const bounded = boundSnapshotMetadata({
      ...page,
      url: snapshot.url,
      screenshot: {
        mimeType: screenshot.mimeType,
        width: screenshot.width,
        height: screenshot.height,
      },
      ...(screenshotPath === undefined ? {} : { screenshotPath }),
    } as SnapshotMetadata);
    return bounded.omitted.length === 0
      ? bounded.value
      : { ...bounded.value, omitted: bounded.omitted };
  });

/** Runs one tool for a credential scope: the same decoding and handler as the MCP tool. */
export const runBrowserTool = (
  scope: McpInvocationContext.McpInvocationScope,
  tool: BrowserCliTool,
  input: unknown,
) =>
  Effect.gen(function* () {
    const decoded = yield* Schema.decodeUnknownEffect(PreviewToolkit.tools[tool].parametersSchema)(
      input ?? {},
    ).pipe(
      Effect.mapError(
        (issue) =>
          new BrowserCliInvalidInput({
            message: `Invalid ${tool.replace("preview_", "").replaceAll("_", "-")} input: ${issue.message}`,
          }),
      ),
    );
    // Each handler takes its own tool's input; the decode above produced exactly that.
    const handler = previewHandlers[tool] as (
      input: unknown,
    ) => Effect.Effect<
      unknown,
      PreviewAutomationError,
      | McpInvocationContext.McpInvocationContext
      | PreviewAutomationBroker.PreviewAutomationBroker
      | ServerConfig.ServerConfig
      | FileSystem.FileSystem
    >;
    const result = yield* handler(decoded);
    if (tool !== "preview_snapshot") return result;
    const includeImage = (decoded as { readonly includeImage?: boolean }).includeImage !== false;
    return yield* snapshotResult(result as Snapshot, includeImage);
  }).pipe(Effect.provideService(McpInvocationContext.McpInvocationContext, scope));

export const browserCliRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const services = yield* Effect.context<
      | PreviewAutomationBroker.PreviewAutomationBroker
      | ServerConfig.ServerConfig
      | FileSystem.FileSystem
      | Path.Path
    >();
    return HttpRouter.add(
      "POST",
      BROWSER_CLI_ROUTE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const scope = token.length > 0 ? yield* registry.resolve(token) : undefined;
        if (!scope) return unauthorized;

        const declaredLength = Number(request.headers["content-length"] ?? "0");
        if (declaredLength > MAX_BODY_BYTES) {
          return refuse("usage", "The request is too large.", 413);
        }
        const text = yield* readBoundedBody(request).pipe(
          Effect.map((value) => ({ _tag: "Read" as const, value })),
          Effect.catch((error) =>
            Effect.succeed({
              _tag: error instanceof BodyTooLarge ? ("TooLarge" as const) : ("Unreadable" as const),
            }),
          ),
        );
        if (text._tag !== "Read") {
          return text._tag === "TooLarge"
            ? refuse("usage", "The request is too large.", 413)
            : refuse("usage", "The request could not be read.", 400);
        }
        const body = decodeJson(text.value);
        const tool =
          body._tag === "Success" && typeof body.value === "object" && body.value !== null
            ? (body.value as { tool?: unknown }).tool
            : undefined;
        if (body._tag === "Failure" || !isTool(tool)) {
          return refuse("usage", "The request must be a JSON object naming a preview tool.");
        }
        const input = (body.value as { input?: unknown }).input;
        // The thread is the credential's, never anything the body claims; a
        // credential without browser access fails in the handler with the
        // same message the MCP tools give.
        return yield* runBrowserTool(scope, tool, input).pipe(
          Effect.provide(services),
          Effect.matchCause({
            onSuccess: (result) => respond({ ok: true, result }),
            onFailure: (cause) => respond({ ok: false, error: browserCliFailure(cause) }),
          }),
        );
      }),
    );
  }),
);
