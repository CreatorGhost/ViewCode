import { VcsProcessExitError } from "@t3tools/contracts";
import type { OrchestrationProjectShell, ProjectId } from "@t3tools/contracts";
import { DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts/settings";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterEach, assert, beforeEach, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as KeyValueStore from "effect/persistence/KeyValueStore";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { detectSourceControlProviderFromGitRemoteUrl } from "@t3tools/shared/git";
import { refineUnknownRemoteProvider } from "@t3tools/source-control-core/server/discovery";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as GitHubPullRequestApi from "@t3tools/source-control-github/server/GitHubPullRequestApi";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import { driver as gitHubDriver } from "@t3tools/source-control-github/server/driver";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";

import * as PullRequestFilesViewed from "../persistence/PullRequestFilesViewed.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ServerSettingsService from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as PullRequestProviderRegistry from "./PullRequestProviderRegistry.ts";
import * as PullRequestReadCache from "./PullRequestReadCache.ts";
import * as PullRequestService from "./PullRequestService.ts";

// A company GitHub Enterprise Server whose name carries no "github" label: the remote reads as an
// unknown host until discovery finds a gh login there. Its pull requests must be listed from that
// host, with that host's credential; this machine has no github.com login at all.
const HOST = "panwgithub.example.local";

function githubEnterprise() {
  const tokenHosts: Array<string> = [];
  const requests: Array<string> = [];
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
          const page = { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] };
          // Batched head lookups alias each repository root as `_<n>_repository`.
          const prefixes = [
            ...new Set(Object.keys(sent.variables).flatMap((key) => /^_\d+_/.exec(key) ?? [])),
          ];
          body = {
            data: sent.query.includes("search(")
              ? { search: page }
              : Object.fromEntries(
                  (prefixes.length === 0 ? [""] : prefixes).map((prefix) => [
                    `${prefix}repository`,
                    { pullRequests: page },
                  ]),
                ),
          };
        } else if (url.pathname.endsWith("/user")) {
          body = { login: "me", id: 1 };
        } else {
          body = {
            full_name: "BAD-GCP/tsw-mfe",
            html_url: `https://${HOST}/BAD-GCP/tsw-mfe`,
            ssh_url: `git@${HOST}:BAD-GCP/tsw-mfe.git`,
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
          if (input.command === "gh" && input.args[0] === "auth" && input.args[1] === "token") {
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
          if (input.command === "gh" && input.args[1] === "status") {
            return Effect.succeed(
              TestSourceControlHost.processOutput(
                JSON.stringify({
                  hosts: { [HOST]: [{ login: "me", host: HOST, state: "success", active: true }] },
                }),
              ),
            );
          }
          return Effect.succeed(
            TestSourceControlHost.processOutput("", {
              exitCode: ChildProcessSpawner.ExitCode(1),
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
  return { layer, tokenHosts, requests };
}

const shell = (workspaceRoot: string): OrchestrationProjectShell => ({
  id: "p1" as ProjectId,
  title: "tsw-mfe",
  workspaceRoot,
  repositoryIdentity: null,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-07-01T00:00:00Z",
  updatedAt: "2026-07-01T00:00:00Z",
});

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

it.effect("reads an Enterprise checkout's pull requests from its remote's own host", () => {
  const github = githubEnterprise();
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped();
    const runner = yield* ProcessRunner.ProcessRunner;
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", `https://${HOST}/BAD-GCP/tsw-mfe.git`],
    ]) {
      yield* runner.run({ command: "git", args: ["-C", root, ...args] });
    }

    const identities = yield* RepositoryIdentityResolver.make({ cacheCapacity: 4 });
    const { discovery, pullRequests: githubPullRequests, sourceControl } = yield* gitHubDriver.make;
    const { process } = yield* SourceControlHost.SourceControlHost;
    const context = yield* Layer.build(
      Layer.mergeAll(
        Layer.mock(ServerSettingsService.ServerSettingsService)({
          getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        }),
        Layer.succeed(
          PullRequestProviderRegistry.PullRequestProviderRegistry,
          PullRequestProviderRegistry.fromProviders([githubPullRequests!]),
        ),
        // The registry's own refinement of an unknown remote, over the GitHub discovery alone.
        Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
          resolveLink: () => undefined,
          resolveHandle: ({ cwd, context }) =>
            refineUnknownRemoteProvider({
              specs: [discovery],
              process,
              cwd,
              context: context!,
            }).pipe(
              Effect.map(({ provider }) => ({
                context: provider === null ? context! : { ...context!, provider },
                provider: undefined as never,
              })),
              Effect.orDie,
            ),
        }),
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed([shell(root)]),
          getShell: () => Effect.succeed(Option.some(shell(root))),
        }),
        Layer.succeed(RepositoryIdentityResolver.RepositoryIdentityResolver, identities),
        SourceControlRateLimit.layer,
        PullRequestFilesViewed.layer.pipe(Layer.provide(SqlitePersistence.layerMemory)),
        Layer.effect(PullRequestReadCache.PullRequestReadCache, PullRequestReadCache.make).pipe(
          Layer.provide(KeyValueStore.layerMemory),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const service = yield* Effect.provideContext(PullRequestService.make, context);

    const result = yield* service.list({ state: "open" });
    assert.deepStrictEqual(result.errors, []);

    // The chat's pull request card: git status looks the thread's branch up through the checkout's
    // source-control provider, with the context the registry refined from the same remote.
    const remoteUrl = `https://${HOST}/BAD-GCP/tsw-mfe.git`;
    const { context: refined } = yield* Effect.provideContext(
      Effect.flatMap(SourceControlProviderRegistry.SourceControlProviderRegistry, (registry) =>
        registry.resolveHandle({
          cwd: root,
          context: {
            provider: detectSourceControlProviderFromGitRemoteUrl(remoteUrl)!,
            remoteName: "origin",
            remoteUrl,
          },
        }),
      ),
      context,
    );
    assert.strictEqual(refined?.provider.kind, "github");
    const lookup = yield* sourceControl
      .listChangeRequests({
        cwd: root,
        context: refined!,
        headSelector: "feature",
        state: "open",
        limit: 1,
      })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(yield* Fiber.join(lookup), []);

    assert.deepStrictEqual(Object.keys(result.viewers), [HOST]);
    assert.deepStrictEqual([...new Set(github.tokenHosts)], [HOST]);
    assert.isTrue(github.requests.length > 0);
    assert.isTrue(github.requests.every((request) => request.startsWith(`${HOST} /api/`)));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(github.layer, ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer))),
    ),
    Effect.provideService(HostProcess.Environment, {}),
  );
});
