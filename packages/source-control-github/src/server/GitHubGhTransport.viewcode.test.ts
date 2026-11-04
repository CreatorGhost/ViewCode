import { SourceControlProviderKind, VcsProcessExitError } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRoutedPullRequestProvider from "./GitHubRoutedPullRequestProvider.ts";
import * as GitHubRoutedSourceControlProvider from "./GitHubRoutedSourceControlProvider.ts";

// Before the v2 merge every GitHub read went through gh, which trusts the machine's own CA store
// and proxy. A company GitHub Enterprise host that Node cannot reach (here: a certificate Node
// does not trust) must still be read, through `gh api`, while github.com stays direct.
const HOST = "ghe.example.local";

const untrustedCertificate = (request: Parameters<HttpClient.HttpClient["execute"]>[0]) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({
      request,
      cause: new TypeError("fetch failed", {
        cause: Object.assign(new Error("unable to verify the first certificate"), {
          code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        }),
      }),
    }),
  });

const node = (number: number) => ({
  number,
  title: `PR ${number}`,
  url: `https://${HOST}/org/repo/pull/${number}`,
  baseRefName: "main",
  headRefName: "feature",
  headRefOid: "f".repeat(40),
  state: "OPEN",
  isDraft: false,
  mergedAt: null,
  closedAt: null,
  isCrossRepository: false,
  updatedAt: "2026-01-02T00:00:00Z",
  headRepository: { name: "repo", nameWithOwner: "org/repo" },
  headRepositoryOwner: { __typename: "Organization", login: "org" },
});

/** What the host answers, whichever transport asked. */
function answer(endpoint: string, body: string | undefined): { status: number; body: unknown } {
  if (endpoint === "graphql") {
    const sent = JSON.parse(body ?? "{}") as {
      readonly query: string;
      readonly variables: Readonly<Record<string, unknown>>;
    };
    const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
    if (sent.query.includes("search(")) return { status: 200, body: { data: { search: page } } };
    const prefixes = [
      ...new Set(Object.keys(sent.variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
    ];
    const repository = sent.query.includes("pullRequests(")
      ? { pullRequests: { ...page, nodes: [node(7)] } }
      : { pullRequest: node(7) };
    return {
      status: 200,
      body: {
        data: Object.fromEntries(
          (prefixes.length === 0 ? [""] : prefixes).map((prefix) => [
            `${prefix}repository`,
            repository,
          ]),
        ),
      },
    };
  }
  if (endpoint.startsWith("user")) return { status: 200, body: { login: "me", id: 1 } };
  return {
    status: 200,
    body: {
      full_name: "org/repo",
      html_url: `https://${HOST}/org/repo`,
      ssh_url: `git@${HOST}:org/repo.git`,
      default_branch: "main",
    },
  };
}

function harness(
  options: {
    /** How the host answers Node directly; a transport failure by default. */
    readonly direct?: (
      request: Parameters<HttpClient.HttpClient["execute"]>[0],
    ) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;
    /** gh cannot reach the host either. */
    readonly ghUnreachable?: boolean;
  } = {},
) {
  const direct: Array<string> = [];
  const ghCalls: Array<{
    readonly args: ReadonlyArray<string>;
    readonly tokenInEnv: boolean;
  }> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      const url = new URL(request.url);
      direct.push(`${url.host} ${url.pathname}`);
      return options.direct?.(request) ?? Effect.fail(untrustedCertificate(request));
    }),
  );
  const sourceHost = TestSourceControlHost.layer({
    process: {
      run: (input) =>
        Effect.suspend(() => {
          if (input.command === "git") {
            return Effect.succeed(
              input.args[0] === "remote"
                ? TestSourceControlHost.processOutput(
                    `origin\thttps://${HOST}/org/repo.git (fetch)\n`,
                  )
                : TestSourceControlHost.processOutput("", {
                    exitCode: ChildProcessSpawner.ExitCode(1),
                  }),
            );
          }
          if (input.command !== "gh") return Effect.die(`Unexpected ${input.command}`);
          if (input.args[0] === "auth" && input.args[1] === "token") {
            return Effect.succeed(TestSourceControlHost.processOutput("token-ghe"));
          }
          if (input.args[0] === "auth" && input.args[1] === "status") {
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify({
                  hosts: { [HOST]: [{ login: "me", host: HOST, state: "success", active: true }] },
                }),
              ),
            );
          }
          if (input.args[0] === "api") {
            ghCalls.push({
              args: input.args,
              tokenInEnv: input.env?.["GH_ENTERPRISE_TOKEN"] === "token-ghe",
            });
            if (options.ghUnreachable) {
              return Effect.succeed(
                TestSourceControlHost.processOutput("", {
                  exitCode: ChildProcessSpawner.ExitCode(1),
                  stderr: `error connecting to ${HOST}\n`,
                }),
              );
            }
            const reply = answer(input.args.at(-1)!, input.stdin);
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                `HTTP/2.0 ${reply.status} OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(reply.body)}`,
              ),
            );
          }
          return Effect.fail(
            new VcsProcessExitError({
              operation: input.operation,
              command: "gh",
              cwd: input.cwd,
              exitCode: 1,
              detail: "unexpected",
            }),
          );
        }),
    },
  });
  const layer = GitHubPullRequestApi.layer.pipe(
    Layer.provideMerge(GitHubRest.layerWithDependencies),
    Layer.provideMerge(sourceHost),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(http),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, direct, ghCalls };
}

const context = {
  provider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub Self-Hosted",
    baseUrl: `https://${HOST}`,
  },
  remoteName: "origin",
  remoteUrl: `https://${HOST}/org/repo.git`,
};

describe("gh as the transport for an Enterprise host Node cannot reach", () => {
  beforeEach(() => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
      "GH_HOST",
      "GH_REPO",
    ])
      vi.stubEnv(name, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.effect("reads the pull request list and detail through gh, then goes to gh directly", () => {
    const { layer, direct, ghCalls } = harness();
    return Effect.gen(function* () {
      const pullRequests = yield* GitHubRoutedPullRequestProvider.make;
      const sourceControl = yield* GitHubRoutedSourceControlProvider.make;
      const list = yield* pullRequests.listChangeRequests({
        cwd: "/repo",
        host: HOST,
        repository: "org/repo",
        state: "open",
        involvement: "all",
        viewer: "me",
        limit: 20,
      });
      assert.deepStrictEqual(list.items, []);
      // The first direct attempt failed; nothing after it went to Node.
      assert.deepStrictEqual(direct, [`${HOST} /api/v3/repos/org/repo`]);

      const branch = yield* sourceControl
        .listChangeRequests({ cwd: "/repo", context, headSelector: "feature", state: "open" })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      assert.deepStrictEqual(
        (yield* Fiber.join(branch)).map((pullRequest) => pullRequest.number),
        [7],
      );
      const detail = yield* sourceControl.getChangeRequest({
        cwd: "/repo",
        context,
        reference: "7",
      });
      assert.strictEqual(detail.title, "PR 7");

      assert.strictEqual(direct.length, 1);
      assert.isTrue(ghCalls.length >= 4);
      for (const call of ghCalls) {
        assert.deepStrictEqual(call.args.slice(0, 3), ["api", "--hostname", HOST]);
        assert.isTrue(call.tokenInEnv);
        assert.isFalse(call.args.some((arg) => arg.includes("token-ghe")));
      }
      assert.isTrue(ghCalls.some((call) => call.args.at(-1) === "graphql"));
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("never sends github.com through gh, and names why it could not be reached", () => {
    const { layer, ghCalls } = harness();
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* api
        .rest({ host: "github.com", operation: "readUser", path: "user" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubApiRequestError");
      assert.include(error.message, "github.com");
      assert.include(error.message, "not trusted");
      assert.deepStrictEqual(ghCalls, []);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("takes an Enterprise host's 401 and 404 as answers, not as a reason to use gh", () => {
    const status = { value: 401 };
    const { layer, ghCalls } = harness({
      direct: (request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(JSON.stringify({ message: "nope" }), {
              status: status.value,
              headers: { "content-type": "application/json" },
            }),
          ),
        ),
    });
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const read = api.rest({ host: HOST, operation: "readRepository", path: "repos/org/repo" });
      assert.strictEqual((yield* Effect.flip(read))._tag, "GitHubApiAuthenticationError");
      status.value = 404;
      assert.strictEqual((yield* Effect.flip(read))._tag, "GitHubApiNotFoundError");
      assert.deepStrictEqual(ghCalls, []);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("says why when neither Node nor gh reaches the host", () => {
    const { layer, ghCalls } = harness({ ghUnreachable: true });
    return Effect.gen(function* () {
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* api
        .rest({ host: HOST, operation: "readRepository", path: "repos/org/repo" })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "GitHubApiRequestError");
      assert.include(error.message, `Could not reach GitHub at ${HOST}`);
      assert.include(error.message, "not trusted");
      assert.include(error.message, `gh: error connecting to ${HOST}`);
      assert.strictEqual(ghCalls.length, 1);
    }).pipe(Effect.scoped, Effect.provide(layer));
  });
});
