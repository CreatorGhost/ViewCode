import { SourceControlProviderKind } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, type HttpClientRequest } from "effect/http";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as GitHubRoutedSourceControlProvider from "./GitHubRoutedSourceControlProvider.ts";
import * as GitHubRest from "./GitHubRest.ts";
import * as GitHubAccountRouting from "./GitHubAccountRouting.ts";

function harness(options: { readonly limited?: boolean; readonly writeStatus?: number } = {}) {
  const requests: Array<{ path: string; method: string; account: string }> = [];
  const commands: Array<ReadonlyArray<string>> = [];
  let active = "personal";
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request: HttpClientRequest.HttpClientRequest) => {
      const path = new URL(request.url).pathname;
      const account = request.headers.authorization?.replace("Bearer credential-", "") ?? "missing";
      requests.push({ path, method: request.method, account });
      const repository = path.startsWith("/repos/work/private") ? "work" : "personal";
      const status =
        request.method !== "GET"
          ? (options.writeStatus ?? 200)
          : options.limited
            ? 429
            : repository === account
              ? 200
              : 404;
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(
            JSON.stringify({
              ok: status === 200,
              full_name: "work/private",
              html_url: "https://github.com/work/private",
              ssh_url: "git@github.com:work/private.git",
              default_branch: "main",
            }),
            {
              status,
              headers: { "content-type": "application/json" },
            },
          ),
        ),
      );
    }),
  );
  const sourceHost = TestSourceControlHost.layer({
    process: {
      run: (input) =>
        Effect.sync(() => {
          commands.push(input.args);
          if (input.command === "ssh") return TestSourceControlHost.processOutput("hostname github.com\n");
          if (input.command === "git") return TestSourceControlHost.processOutput("");
          if (input.args[1] === "status")
            return TestSourceControlHost.processOutput(
              JSON.stringify({
                hosts: {
                  "github.com": ["personal", "work"].map((login) => ({
                    login,
                    host: "github.com",
                    state: "success",
                    active: login === active,
                  })),
                },
              }),
            );
          const account = input.args.includes("--user")
            ? input.args[input.args.indexOf("--user") + 1]
            : active;
          return TestSourceControlHost.processOutput(`credential-${account}`);
        }),
    },
  });
  const layer = GitHubRest.layerWithDependencies.pipe(
    Layer.provideMerge(sourceHost),
    Layer.provide(NodeCrypto.layer),
    Layer.provideMerge(http),
  );
  return {
    layer,
    requests,
    commands,
    activate: (account: string) => {
      active = account;
    },
  };
}

describe("GitHub account routing", () => {
  beforeEach(() => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      vi.stubEnv(name, "");
  });
  afterEach(() => vi.unstubAllEnvs());

  it.effect(
    "routes two repositories to separate API credentials without changing the active login",
    () => {
      const { layer, requests, commands } = harness();
      return Effect.gen(function* () {
        const route = yield* GitHubAccountRouting.make;
        const api = yield* GitHubRest.GitHubRest;
        for (const repository of [
          "personal/public",
          "work/private",
          "personal/public",
          "work/private",
        ]) {
          yield* route(
            { host: "github.com", repository, cwd: "/w" },
            api.rest({
              host: "github.com",
              operation: "readPullRequest",
              path: `repos/${repository}/pulls/7`,
            }),
          );
        }
        expect(requests.filter((request) => request.path.endsWith("/pulls/7"))).toEqual([
          { path: "/repos/personal/public/pulls/7", method: "GET", account: "personal" },
          { path: "/repos/work/private/pulls/7", method: "GET", account: "work" },
          { path: "/repos/personal/public/pulls/7", method: "GET", account: "personal" },
          { path: "/repos/work/private/pulls/7", method: "GET", account: "work" },
        ]);
        expect(commands.some((args) => args.includes("switch"))).toBe(false);
      }).pipe(Effect.provide(layer));
    },
  );

  it.effect("pins all calls in an operation and sends a refused write only once", () => {
    const { layer, requests } = harness({ writeStatus: 403 });
    return Effect.gen(function* () {
      const route = yield* GitHubAccountRouting.make;
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* route(
        { host: "github.com", repository: "work/private", cwd: "/w" },
        Effect.gen(function* () {
          yield* api.rest({
            host: "github.com",
            operation: "readNode",
            path: "repos/work/private/pulls/7",
          });
          return yield* api.rest({
            host: "github.com",
            operation: "review",
            method: "POST",
            path: "repos/work/private/pulls/7/reviews",
            body: { body: "review" },
          });
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiResponseError");
      expect(requests.filter((request) => request.method === "POST")).toEqual([
        { path: "/repos/work/private/pulls/7/reviews", method: "POST", account: "work" },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("keeps rate-limit failures on the original account", () => {
    const { layer, requests, commands } = harness({ limited: true });
    return Effect.gen(function* () {
      const route = yield* GitHubAccountRouting.make;
      const error = yield* route(
        { host: "github.com", repository: "work/private", cwd: "/w" },
        Effect.void,
      ).pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiRateLimitError");
      expect(requests).toHaveLength(1);
      expect(commands.some((args) => args[1] === "status")).toBe(false);
    }).pipe(Effect.provide(layer));
  });

  it.effect("an explicit environment token remains the account boundary", () => {
    vi.stubEnv("GH_TOKEN", "credential-explicit");
    const { layer, commands } = harness();
    return Effect.gen(function* () {
      const route = yield* GitHubAccountRouting.make;
      const api = yield* GitHubRest.GitHubRest;
      const error = yield* route(
        { host: "github.com", repository: "work/private", cwd: "/w" },
        api.rest({
          host: "github.com",
          operation: "read",
          path: "repos/work/private/pulls/7",
        }),
      ).pipe(Effect.flip);
      expect(error._tag).toBe("GitHubApiNotFoundError");
      expect(commands).toEqual([]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("refreshes routes after the active credential changes", () => {
    const { layer, requests, activate } = harness();
    return Effect.gen(function* () {
      const route = yield* GitHubAccountRouting.make;
      const api = yield* GitHubRest.GitHubRest;
      const read = () =>
        route(
          { host: "github.com", repository: "work/private", cwd: "/w" },
          api.rest({
            host: "github.com",
            operation: "read",
            path: "repos/work/private/pulls/7",
          }),
        );
      yield* read();
      activate("work");
      yield* TestClock.adjust("6 minutes");
      yield* read();
      expect(requests.at(-1)?.account).toBe("work");
      expect(requests.filter((request) => request.path === "/repos/work/private")).toHaveLength(3);
    }).pipe(Effect.provide(layer));
  });
});

it.effect(
  "routes checkout metadata and PR creation through the source-control API without gh writes",
  () => {
    for (const name of [
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "GH_ENTERPRISE_TOKEN",
      "GITHUB_ENTERPRISE_TOKEN",
    ])
      vi.stubEnv(name, "");
    const { layer, requests, commands } = harness();
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped();
      const bodyFile = `${directory}/body.md`;
      yield* fs.writeFileString(bodyFile, "Review this change");
      const provider = yield* GitHubRoutedSourceControlProvider.make;
      const input = {
        cwd: directory,
        context: {
          provider: { kind: SourceControlProviderKind.make("github"), name: "github.com-work", baseUrl: "https://github.com-work" },
          remoteName: "origin",
          remoteUrl: "git@github.com-work:work/private.git",
        },
      };
      expect(yield* provider.getDefaultBranch(input)).toBe("main");
      yield* provider.createChangeRequest({
        ...input,
        baseRefName: "main",
        headSelector: "feature",
        title: "A change",
        bodyFile,
      });
      expect(requests.filter((request) => request.method === "POST")).toEqual([
        { path: "/repos/work/private/pulls", method: "POST", account: "work" },
      ]);
      expect(commands.some((args) => args[0] === "-G" && args[1] === "github.com-work")).toBe(true);
      expect(commands.some((args) => args.includes("github.com-work") && args[0] === "auth")).toBe(false);
      expect(commands.some((args) => args[0] === "pr" || args.includes("switch"))).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(Layer.merge(layer, NodeServices.layer)));
  },
);
