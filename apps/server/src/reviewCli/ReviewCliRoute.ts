/**
 * `POST /api/review-findings`: what the `viewcode-review` CLI calls.
 *
 * It runs the `submit_review_findings` MCP tool's own handler with the same
 * input schema, so a reviewer whose MCP servers are blocked still gets its
 * findings into the Review panel, through the same gate and the same record.
 * Authenticated with the provider session's MCP credential (the CLI gets it as
 * `VIEWCODE_REVIEW_AUTH`); the thread always comes from that credential.
 * Refusals answer 200 with `ok: false` so the CLI can print them; only a bad
 * credential is 401.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { makeSubmitReviewFindings } from "../mcp/toolkits/pullRequests/handlers.ts";
import { SubmitReviewFindingsInput } from "../mcp/toolkits/pullRequests/tools.ts";
import {
  REVIEW_CLI_ROUTE_PATH,
  type ReviewCliError,
  type ReviewCliResponse,
} from "./reviewCliProtocol.ts";

/** 50 findings at their longest are about 200 KB; leave room for JSON escaping. */
const MAX_BODY_BYTES = 1024 * 1024;

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const decodeInput = Schema.decodeUnknownExit(SubmitReviewFindingsInput);

const noStore = { "cache-control": "no-store" };

const respond = (body: ReviewCliResponse, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });

const refuse = (code: string, message: string, status = 200) =>
  respond({ ok: false, error: { code, message } }, status);

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    ok: false,
    error: {
      code: "credential",
      message:
        "This review credential is missing, unknown or expired. Ask the user to restart the agent session.",
    },
  },
  { status: 401, headers: { ...noStore, "www-authenticate": "Bearer" } },
);

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

/** The failure the agent sees: the tool's own errors say what to do next. */
const reviewCliFailure = (cause: Cause.Cause<unknown>): ReviewCliError => {
  const error = cause.reasons.find(Cause.isFailReason)?.error;
  if (typeof error === "object" && error !== null && "_tag" in error) {
    const tag = String((error as { _tag: unknown })._tag);
    const message = (error as { message?: unknown }).message;
    return {
      code: tag,
      message: typeof message === "string" && message.length > 0 ? message : `${tag}.`,
    };
  }
  return { code: "internal", message: "Recording the review findings failed unexpectedly." };
};

export const reviewCliRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const submitReviewFindings = yield* makeSubmitReviewFindings;
    return HttpRouter.add(
      "POST",
      REVIEW_CLI_ROUTE_PATH,
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
          return refuse("usage", "The findings are too large.", 413);
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
            ? refuse("usage", "The findings are too large.", 413)
            : refuse("usage", "The request could not be read.", 400);
        }
        const body = decodeJson(text.value);
        if (body._tag === "Failure") {
          return refuse("usage", "The findings must be one JSON object.");
        }
        // The MCP tool's own schema; every problem at once so one retry can fix them all.
        const input = decodeInput(body.value, { errors: "all" });
        if (input._tag === "Failure") {
          const issue = input.cause.reasons.find(Cause.isFailReason)?.error;
          return refuse(
            "usage",
            `Invalid findings: ${issue?.message ?? "they do not match the expected shape"}`,
          );
        }
        // The thread is the credential's, never anything the body claims.
        return yield* submitReviewFindings(input.value).pipe(
          Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
          Effect.matchCause({
            onSuccess: (result) => respond({ ok: true, result }),
            onFailure: (cause) => respond({ ok: false, error: reviewCliFailure(cause) }),
          }),
        );
      }),
    );
  }),
);
