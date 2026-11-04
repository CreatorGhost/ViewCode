// @effect-diagnostics preferSchemaOverJson:off - asserts on the raw JSON the route writes.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThreadActivity,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpBody, HttpClient, HttpRouter } from "effect/http";

import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ReviewActivityStoreV2 } from "../review/ReviewActivityStoreV2.ts";
import * as PullRequestAgentReview from "../pullRequest/PullRequestAgentReview.ts";
import { reviewCliRouteLayer } from "./ReviewCliRoute.ts";

const reviewThread = ThreadId.make("review-thread");
const otherThread = ThreadId.make("other-thread");

const scope = (
  threadId: ThreadId,
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "review-cli-test",
  thread: {
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("claude"),
  },
  client: undefined,
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

const thread: OrchestrationV2ThreadShell = {
  ...liveThreadShell(reviewThread),
  id: reviewThread,
  projectId: ProjectId.make("project"),
  title: "Review: #7",
  modelSelection: { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [
    {
      host: "github.com",
      repository: "t3tools/t3code",
      number: 7,
      url: "https://github.com/t3tools/t3code/pull/7",
      source: "manual",
      linkedAt: "2026-08-10T00:00:00.000Z",
      snapshot: null,
      stack: null,
    },
  ],
  createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  activeRunId: null,
  latestUserMessageAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
  hasActionableProposedPlan: false,
};

/** A re-review: what the server recorded when it started this one. */
const started: OrchestrationThreadActivity = {
  id: EventId.make("started"),
  tone: "info",
  kind: "viewcode.review.started",
  summary: "Review started",
  payload: {
    headSha: "bbbbbbb",
    incremental: true,
    basedOn: { activityId: "earlier", headSha: "aaaaaaa" },
    timelineBypass: true,
  },
  turnId: null,
  createdAt: "2026-08-20T00:00:00.000Z",
};

const report = {
  verdict: "request-changes",
  mergeConfidence: 2,
  reviewEffort: 3,
  findings: [
    {
      severity: "blocker",
      confidence: 90,
      path: "src/a.ts",
      line: 4,
      title: "Unchecked input",
      detail: "The handler passes the query straight to the shell.",
    },
  ],
  needsChecking: [],
};

const serve = Effect.gen(function* () {
  const commands: Array<Parameters<ReviewActivityStoreV2["Service"]["append"]>[0]> = [];
  const routes = reviewCliRouteLayer.pipe(
    Layer.provide(
      Layer.mock(McpSessionRegistry.McpSessionRegistry)({
        resolve: (token) =>
          Effect.succeed(
            token === "reviewer"
              ? scope(reviewThread)
              : token === "gone"
                ? scope(otherThread)
                : token === "no-pull-requests"
                  ? scope(reviewThread, ["orchestration"])
                  : undefined,
          ),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: (threadId) => Effect.succeed(threadId === reviewThread ? thread : null),
      }),
    ),
    Layer.provide(
      Layer.mock(ReviewActivityStoreV2)({
        list: (_threadId, kinds) =>
          Effect.succeed(
            [started].filter((activity) => kinds === undefined || kinds.includes(activity.kind)),
          ),
        append: (command) =>
          Effect.sync(() => {
            commands.push(command);
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(PullRequestAgentReview.PullRequestAgentReview)({
        authorship: () => Effect.succeed({ author: "octocat", viewer: "someone-else" }),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        Crypto.Crypto,
        Crypto.make({
          randomBytes: (size) => new Uint8Array(size).fill(7),
          digest: (_algorithm, data) => Effect.succeed(data),
        }),
      ),
    ),
  );
  yield* HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
    Layer.build,
  );
  return { client: yield* HttpClient.HttpClient, commands };
});

const post = (client: HttpClient.HttpClient, authorization: string | undefined, body: string) =>
  client.post("/api/review-findings", {
    headers: authorization ? { authorization } : {},
    body: HttpBody.text(body, "application/json"),
  });

const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer)),
  );

it.effect("rejects a missing or unknown credential with 401", () =>
  run(
    Effect.gen(function* () {
      const { client, commands } = yield* serve;
      const body = JSON.stringify(report);
      expect((yield* post(client, undefined, body)).status).toBe(401);
      expect((yield* post(client, "Bearer forged", body)).status).toBe(401);
      expect(commands).toEqual([]);
    }),
  ),
);

it.effect("refuses what the MCP tool's schema refuses, naming every field, before recording", () =>
  run(
    Effect.gen(function* () {
      const { client, commands } = yield* serve;
      const invalid = yield* post(
        client,
        "Bearer reviewer",
        JSON.stringify({ ...report, verdict: "lgtm", mergeConfidence: 9 }),
      );
      expect(invalid.status).toBe(200);
      const body = (yield* invalid.json) as {
        ok: boolean;
        error: { code: string; message: string };
      };
      expect(body).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(body.error.message).toContain("verdict");
      expect(body.error.message).toContain("mergeConfidence");

      const notJson = yield* post(client, "Bearer reviewer", "{findings:");
      expect(yield* notJson.json).toMatchObject({ ok: false, error: { code: "usage" } });
      expect(commands).toEqual([]);
    }),
  ),
);

it.effect("records a re-review's findings on the credential's thread, ignoring the body's", () =>
  run(
    Effect.gen(function* () {
      const { client, commands } = yield* serve;
      const response = yield* post(
        client,
        "Bearer reviewer",
        JSON.stringify({
          ...report,
          complete: false,
          previous: { fixed: 2, stillOpen: 1 },
          threadId: "someone-elses-thread",
        }),
      );
      expect(yield* response.json).toMatchObject({
        ok: true,
        result: { target: "pull-request", findings: 1, needsChecking: 0 },
      });
      expect(commands).toMatchObject([
        {
          threadId: reviewThread,
          activity: {
            kind: "viewcode.review.findings",
            summary: "Review so far: request changes, 1 finding",
            payload: {
              ...report,
              target: { kind: "pull-request", number: 7 },
              mode: "comment",
              headSha: "bbbbbbb",
              incremental: true,
              basedOn: { activityId: "earlier", headSha: "aaaaaaa" },
              previous: { fixed: 2, stillOpen: 1 },
              complete: false,
            },
          },
        },
      ]);
    }),
  ),
);

it.effect("passes the tool's own refusals through", () =>
  run(
    Effect.gen(function* () {
      const { client, commands } = yield* serve;
      const body = JSON.stringify(report);
      expect(yield* (yield* post(client, "Bearer gone", body)).json).toMatchObject({
        ok: false,
        error: { code: "PullRequestThreadNotFoundError", message: expect.any(String) },
      });
      expect(yield* (yield* post(client, "Bearer no-pull-requests", body)).json).toMatchObject({
        ok: false,
        error: { code: "McpCapabilityUnavailableError" },
      });
      expect(commands).toEqual([]);
    }),
  ),
);
