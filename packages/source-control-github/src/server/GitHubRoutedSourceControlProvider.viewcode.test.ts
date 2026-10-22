import { SourceControlProviderKind, VcsProcessExitError } from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, describe, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import * as GitHubRequestPolicy from "./GitHubRequestPolicy.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubRoutedPullRequestProvider from "./GitHubRoutedPullRequestProvider.ts";
import * as GitHubRoutedSourceControlProvider from "./GitHubRoutedSourceControlProvider.ts";

// A GitHub Enterprise Server whose name has no "github" label reads as an unknown remote, and
// discovery claims it because gh is signed in there. Every read of its repository must go to that
// host with that host's credential; github.com has no login here at all.
const HOST = "ghe.example.local";
const REMOTE = `https://${HOST}/org/repo.git`;

const context = {
  provider: {
    kind: SourceControlProviderKind.make("github"),
    name: "GitHub Self-Hosted",
    baseUrl: `https://${HOST}`,
  },
  remoteName: "origin",
  remoteUrl: REMOTE,
};

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

function harness(options: { readonly sshHostname?: string } = {}) {
  /** The host each `gh auth token` was asked for. */
  const tokenHosts: Array<string> = [];
  /** `host path` of every HTTP request. */
  const requests: Array<string> = [];
  const commands: Array<ReadonlyArray<string>> = [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.sync(() => {
        const url = new URL(request.url);
        requests.push(`${url.host} ${url.pathname}`);
        let body: unknown;
        if (url.pathname.endsWith("/graphql")) {
          const sent =
            request.body._tag === "Uint8Array"
              ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
                  readonly query: string;
                  readonly variables: Readonly<Record<string, unknown>>;
                })
              : { query: "", variables: {} };
          const prefixes = [
            ...new Set(Object.keys(sent.variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
          ];
          const answer = sent.query.includes("pullRequests(")
            ? { pullRequests: { nodes: [node(7)] } }
            : { pullRequest: node(7) };
          body = {
            data: Object.fromEntries(
              (prefixes.length === 0 ? [""] : prefixes).map((prefix) => [
                `${prefix}repository`,
                answer,
              ]),
            ),
          };
        } else {
          body = {
            full_name: "org/repo",
            html_url: `https://${HOST}/org/repo`,
            ssh_url: `git@${HOST}:org/repo.git`,
            default_branch: "main",
          };
        }
        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } }),
        );
      }),
    ),
  );
  const sourceHost = TestSourceControlHost.layer({
    process: {
      run: (input) =>
        Effect.suspend(() => {
          commands.push([input.command, ...input.args]);
          if (input.command === "ssh") {
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                `hostname ${options.sshHostname ?? input.args[1]}\n`,
              ),
            );
          }
          if (input.command === "git") {
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                input.args[0] === "remote" ? `origin\t${REMOTE} (fetch)\n` : "",
                input.args[0] === "remote"
                  ? undefined
                  : { exitCode: ChildProcessSpawner.ExitCode(1) },
              ),
            );
          }
          if (input.args[0] === "auth" && input.args[1] === "token") {
            const host = input.args[input.args.indexOf("--hostname") + 1]!;
            tokenHosts.push(host);
            return host === HOST
              ? Effect.succeed(TestSourceControlHost.processOutput(`token-${host}`))
              : Effect.fail(
                  new VcsProcessExitError({
                    operation: input.operation,
                    command: "gh",
                    cwd: input.cwd,
                    exitCode: 1,
                    detail: `no oauth token found for ${host}`,
                  }),
                );
          }
          if (input.args[0] === "auth" && input.args[1] === "status") {
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify({
                  hosts: {
                    [HOST]: [{ login: "me", host: HOST, state: "success", active: true }],
                  },
                }),
              ),
            );
          }
          return Effect.die(`Unexpected ${input.command} ${input.args.join(" ")}`);
        }),
    },
  });
  const layer = GitHubRest.layerWithDependencies.pipe(
    Layer.provideMerge(sourceHost),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(http),
    Layer.provideMerge(NodeServices.layer),
  );
  return { layer, tokenHosts, requests, commands };
}

describe("GitHub Enterprise remotes", () => {
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

  // The chat's pull request card and the git status poll find a branch's pull request this way.
  it.effect("looks a branch's pull request up on the remote's own host", () => {
    const { layer, tokenHosts, requests } = harness();
    return Effect.gen(function* () {
      const provider = yield* GitHubRoutedSourceControlProvider.make;
      const listing = yield* provider
        .listChangeRequests({
          cwd: "/repo",
          context,
          headSelector: "feature",
          state: "open",
          limit: 1,
        })
        .pipe(Effect.forkChild);
      yield* TestClock.adjust("1 second");
      const found = yield* Fiber.join(listing);
      assert.deepStrictEqual(
        found.map((pullRequest) => pullRequest.number),
        [7],
      );
      const detail = yield* provider.getChangeRequest({ cwd: "/repo", context, reference: "#7" });
      assert.strictEqual(detail.number, 7);
      assert.deepStrictEqual([...new Set(tokenHosts)], [HOST]);
      assert.isTrue(requests.length > 0);
      assert.isTrue(requests.every((request) => request.startsWith(`${HOST} /api/`)));
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  it.effect("never takes an HTTPS remote's scheme for an SSH alias", () => {
    // An SSH config that answers every name with github.com must not move an HTTPS remote there.
    const { layer, tokenHosts, commands } = harness({ sshHostname: "github.com" });
    return Effect.gen(function* () {
      const provider = yield* GitHubRoutedSourceControlProvider.make;
      assert.strictEqual(yield* provider.getDefaultBranch({ cwd: "/repo", context }), "main");
      assert.deepStrictEqual([...new Set(tokenHosts)], [HOST]);
      assert.isFalse(commands.some(([command]) => command === "ssh"));
    }).pipe(Effect.scoped, Effect.provide(layer));
  });

  // The Pull requests page's list, its light search across repositories, and the detail view.
  it.effect("lists, searches and reads detail with the remote host's credential", () => {
    const { layer, tokenHosts, requests } = harness();
    const reads: Array<{ readonly operation: string; readonly host: string; pinned: string }> = [];
    const pinnedHost = Effect.map(GitHubRequestPolicy.PinnedGitHubCredential, (credential) => {
      if (credential === null) throw new Error("A repository read was not pinned to a credential");
      return credential.host;
    });
    const read = (operation: string, host: string) =>
      Effect.map(pinnedHost, (pinned) => {
        reads.push({ operation, host, pinned });
      });
    const mockApi = Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      getViewerLogin: (input) => Effect.as(read("viewer", input.host), "me"),
      listActorAvatars: () => Effect.succeed(new Map()),
      listPullRequests: (input) =>
        Effect.as(read("list", input.host), { items: [], truncated: false, continues: false }),
      searchPullRequests: (input) =>
        Effect.as(read("search", input.host), { items: [], truncated: false }),
      getPullRequestDetail: (input) =>
        read("detail", input.host).pipe(
          Effect.andThen(
            Effect.fail(
              new GitHubRequestPolicy.GitHubApiNotFoundError({
                host: input.host,
                operation: "getPullRequestDetail",
              }),
            ),
          ),
        ),
    });
    return Effect.gen(function* () {
      const provider = yield* GitHubRoutedPullRequestProvider.make;
      const input = {
        cwd: "/repo",
        host: HOST,
        state: "open" as const,
        involvement: "all" as const,
        viewer: "me",
        limit: 20,
      };
      yield* provider.listChangeRequests({ ...input, repository: "org/repo" });
      yield* provider.listChangeRequestsAcross!({ ...input, repositories: ["org/repo"] });
      yield* provider
        .getChangeRequest({ cwd: "/repo", host: HOST, repository: "org/repo", number: 7 })
        .pipe(Effect.flip);
      assert.deepStrictEqual([...new Set(reads.map(({ operation }) => operation))].sort(), [
        "detail",
        "list",
        "search",
        "viewer",
      ]);
      assert.isTrue(reads.every((entry) => entry.host === HOST && entry.pinned === HOST));
      assert.deepStrictEqual([...new Set(tokenHosts)], [HOST]);
      // The account probe that picks the reader goes to the same host.
      assert.include(requests, `${HOST} /api/v3/repos/org/repo`);
      assert.isTrue(requests.every((request) => request.startsWith(`${HOST} /api/`)));
    }).pipe(Effect.scoped, Effect.provide(Layer.mergeAll(layer, mockApi)));
  });
});
