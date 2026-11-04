/**
 * ViewCode guard: GitHub Enterprise Server 3.18 rejects any document that names
 * `PullRequest.stack` or `stackEntry` ("Field 'stack' doesn't exist on type 'PullRequest'"),
 * even under `@include(if: false)`, because it validates fields before directives. So nothing sent
 * to a host other than github.com may name them or declare `$stacks`, and those hosts offer no
 * stack features. github.com keeps them.
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, beforeEach, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubCredentials from "./GitHubCredentials.ts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubPullRequestProvider from "./GitHubPullRequestProvider.ts";
import * as GitHubQuota from "./GitHubQuota.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";

const ENTERPRISE = "ghe.example.local";

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeSent = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      query: Schema.String,
      variables: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    }),
  ),
);

interface Sent {
  readonly host: string;
  readonly query: string;
  readonly variables: Readonly<Record<string, unknown>>;
}
const sent: Array<Sent> = [];
beforeEach(() => {
  sent.length = 0;
});

const row = (number: number) => ({
  number,
  title: `Pull request ${number}`,
  url: `https://${ENTERPRISE}/acme/web/pull/${number}`,
  author: null,
  headRefName: "feature",
  baseRefName: "main",
  state: "OPEN",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  latestReviews: { nodes: [] },
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-02T00:00:00Z",
  mergedAt: null,
  repository: { nameWithOwner: "acme/web" },
  reviewRequests: { nodes: [] },
  labels: { nodes: [] },
  commits: { nodes: [] },
});
const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [row(209)] };
const summary = (number: number) => ({
  ...row(number),
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  closedAt: null,
});

/** Answers each operation as GitHub would, and records what was sent where. */
function answer(query: string): unknown {
  if (/^query (Enterprise)?PullRequestSearch\(/.test(query)) return { search: page };
  if (/^query (Enterprise)?PullRequestList\(/.test(query)) {
    return { repository: { pullRequests: page } };
  }
  if (query.startsWith("query PullRequestStackMembership(")) return {};
  // An aliased summary batch of one.
  return { _0_repository: { pullRequest: summary(209) } };
}

const http = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) =>
    Effect.sync(() => {
      const host = new URL(request.url).hostname.replace(/^api\./, "");
      const body =
        request.body._tag === "Uint8Array"
          ? decodeSent(new TextDecoder().decode(request.body.body))
          : { query: "", variables: {} };
      sent.push({ host, query: body.query, variables: body.variables ?? {} });
      return HttpClientResponse.fromWeb(
        request,
        new Response(encodeJson({ data: answer(body.query) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    }),
  ),
);

const layer = it.layer(
  GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(
      Layer.succeed(
        GitHubRest.GitHubRest,
        GitHubRest.GitHubRest.of({
          rest: () => Effect.die("no REST read is expected here"),
          credential: (host) =>
            Effect.succeed({ token: Redacted.make("token"), fingerprint: `${host}:token` }),
        }),
      ),
    ),
    Layer.provideMerge(GitHubRequestPolicy.layer),
    Layer.provideMerge(GitHubQuota.layer),
    Layer.provideMerge(SourceControlRateLimit.layer),
    Layer.provideMerge(http),
    Layer.provideMerge(
      Layer.succeed(GitHubCredentials.GitHubCredentials, {
        get: (host) =>
          Effect.succeed({
            token: Redacted.make("token"),
            fingerprint: `${host}:token`,
            host,
            source: "gh" as const,
          }),
        invalidate: () => Effect.void,
      }),
    ),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(TestSourceControlHost.layer()),
    Layer.provide(NodeServices.layer),
  ),
);

const STACK_FIELDS = /\bstack\b|\bstackEntry\b|\$stacks\b/;

function everyRead(host: string) {
  const reads = sent.filter((call) => call.host === host);
  assert.isAbove(reads.length, 0, `nothing was sent to ${host}`);
  return reads;
}

layer("GitHub Enterprise pull request reads (ViewCode)", (it) => {
  it.effect("sends an Enterprise host no stack field and no $stacks variable", () =>
    Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const base = { cwd: "/w", repository: "acme/web", host: ENTERPRISE } as const;

      // The listing through search, and the repository's own list when search finds nothing.
      const listed = yield* api.listPullRequests({
        ...base,
        state: "open",
        involvement: "all",
        viewer: "octocat",
        limit: 10,
      });
      assert.deepStrictEqual(
        listed.items.map((item) => item.number),
        [209],
      );
      yield* api.searchPullRequests({
        ...base,
        repositories: ["acme/web"],
        state: "open",
        involvement: "all",
        viewer: "octocat",
        limit: 10,
      });
      const read = yield* api
        .getPullRequestSummary({ ...base, number: 209 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const pullRequest = yield* Fiber.join(read);
      assert.strictEqual(pullRequest.number, 209);

      for (const call of everyRead(ENTERPRISE)) {
        expect(call.query).not.toMatch(STACK_FIELDS);
        expect(Object.keys(call.variables).some((name) => /stacks$/.test(name))).toBe(false);
      }
    }),
  );

  it.effect("keeps stacks in what github.com is sent", () =>
    Effect.gen(function* () {
      const api = yield* GitHubPullRequestApi.GitHubPullRequestApi;
      const base = { cwd: "/w", repository: "acme/web", host: "github.com" } as const;

      yield* api.listPullRequests({
        ...base,
        state: "open",
        involvement: "all",
        viewer: "octocat",
        limit: 10,
      });
      const read = yield* api
        .getPullRequestSummary({ ...base, number: 209 })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(read);

      const queries = everyRead("github.com").map((call) => call.query);
      expect(queries.some((query) => query.startsWith("query PullRequestSearch("))).toBe(true);
      expect(queries.every((query) => /\bstack\b/.test(query))).toBe(true);
    }),
  );

  it.effect("offers stack features on github.com only", () =>
    Effect.gen(function* () {
      const provider = yield* GitHubPullRequestProvider.make;
      const enterprise = provider.capabilitiesForHost?.(ENTERPRISE);
      const dotCom = provider.capabilitiesForHost?.("github.com");

      assert.strictEqual(enterprise?.stacks, false);
      assert.strictEqual(enterprise?.stackActions, false);
      assert.strictEqual(dotCom?.stacks, true);
      assert.strictEqual(dotCom?.stackActions, true);
    }),
  );
});
