/**
 * `POST /api/computer-use`: what the `viewcode-computer` CLI calls.
 *
 * Authenticated with the provider session's MCP credential (the CLI gets it
 * as `VIEWCODE_COMPUTER_AUTH`), and the thread always comes from that
 * credential: a thread id in the body is never read. Policy refusals answer
 * 200 with `ok: false` so the CLI can print them; only a bad credential is 401.
 */
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { ComputerUseService } from "./ComputerUseService.ts";
import { COMPUTER_USE_ROUTE_PATH, computerUseError } from "./computerUsePolicy.ts";

/** Typed text is capped at 10k characters; leave room for JSON escaping. */
const MAX_BODY_BYTES = 128 * 1024;

const decodeJson = Schema.decodeUnknownExit(Schema.fromJsonString(Schema.Unknown));

const noStore = { "cache-control": "no-store" };

const unauthorized = HttpServerResponse.jsonUnsafe(
  {
    ok: false,
    error: computerUseError(
      "CU-CON-001",
      "This computer-use credential is missing, unknown or expired. Restart the agent session.",
    ),
  },
  { status: 401, headers: { ...noStore, "www-authenticate": "Bearer" } },
);

const respond = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: noStore });

/**
 * Refusals answered here never reach the service, so they get their own INFO
 * line: a stale session's "not enabled" is otherwise invisible in the logs.
 */
const logRejected = (fields: {
  readonly code: string;
  readonly status: number;
  readonly reason: string;
  readonly threadId?: string;
}) => Effect.logInfo("computer use request rejected", fields);

class BodyTooLarge {
  readonly _tag = "BodyTooLarge";
}

const readBoundedBody = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    // Stop reading as soon as the cap is passed; never buffer an unbounded body.
    yield* Stream.runForEach(request.stream, (chunk: Uint8Array) => {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) return Effect.fail(new BodyTooLarge());
      chunks.push(chunk);
      return Effect.void;
    });
    return Buffer.concat(chunks).toString("utf8");
  });

export const computerUseRouteLayer = Layer.unwrap(
  Effect.gen(function* () {
    const registry = yield* McpSessionRegistry.McpSessionRegistry;
    const computerUse = yield* ComputerUseService;
    return HttpRouter.add(
      "POST",
      COMPUTER_USE_ROUTE_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const authorization = request.headers.authorization;
        const token =
          authorization?.startsWith("Bearer ") === true
            ? authorization.slice("Bearer ".length).trim()
            : "";
        const scope = token.length > 0 ? yield* registry.resolve(token) : undefined;
        if (!scope) {
          yield* logRejected({ code: "CU-CON-001", status: 401, reason: "credential" });
          return unauthorized;
        }
        const threadId = scope.threadId;
        if (!scope.capabilities.has("computer")) {
          yield* logRejected({ code: "CU-CON-001", status: 200, reason: "not-enabled", threadId });
          return respond({
            ok: false,
            error: computerUseError(
              "CU-CON-001",
              "Computer use was not enabled when this agent session started. Ask the user to turn it on in ViewCode settings and restart the agent session.",
            ),
          });
        }

        const declaredLength = Number(request.headers["content-length"] ?? "0");
        if (declaredLength > MAX_BODY_BYTES) {
          yield* logRejected({ code: "CU-VAL-003", status: 413, reason: "too-large", threadId });
          return respond(
            { ok: false, error: computerUseError("CU-VAL-003", "The request body is too large.") },
            413,
          );
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
          const status = text._tag === "TooLarge" ? 413 : 400;
          yield* logRejected({
            code: "CU-VAL-003",
            status,
            reason: text._tag === "TooLarge" ? "too-large" : "unreadable",
            threadId,
          });
          return respond(
            {
              ok: false,
              error: computerUseError(
                "CU-VAL-003",
                text._tag === "TooLarge"
                  ? "The request body is too large."
                  : "The request body could not be read.",
              ),
            },
            status,
          );
        }
        const body = decodeJson(text.value);
        if (body._tag === "Failure") {
          yield* logRejected({ code: "CU-VAL-001", status: 200, reason: "not-json", threadId });
          return respond({
            ok: false,
            error: computerUseError(
              "CU-VAL-001",
              "The request body must be a JSON object with a command.",
            ),
          });
        }
        // The thread is the credential's, never anything the body claims.
        const response = yield* computerUse.handle(
          { threadId, providerInstanceId: scope.providerInstanceId },
          body.value,
        );
        return respond(response);
      }),
    );
  }),
);
