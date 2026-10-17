import { assert, it } from "@effect/vitest";
import { VcsProcessExitError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as GitHubPullRequestCli from "../pullRequest/GitHubPullRequestCli.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitHubCli from "./GitHubCli.ts";
import { gitHubCommandTarget } from "./gitHubAccountRouting.ts";
import * as GitHubGraphQlBudget from "./githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "./SourceControlRateLimit.ts";

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Struct({ query: Schema.String })),
);

it("routes node-ID writes only with unambiguous repository context", () => {
  const input = {
    args: ["api", "graphql", "--hostname", "github.com", "--input", "-"],
    stdin: encodeJson({ query: "mutation M { x }", variables: { threadId: "PRRT_1" } }),
    defaultHost: "github.com",
  };
  assert.isNull(gitHubCommandTarget(input));
  assert.deepStrictEqual(gitHubCommandTarget({ ...input, repository: "Acme/web" }), {
    host: "github.com",
    owner: "acme",
    read: false,
  });
  assert.isNull(gitHubCommandTarget({ ...input, repository: "enterprise.test/acme/web" }));
  assert.isNull(
    gitHubCommandTarget({
      ...input,
      args: [...input.args, "-f", "owner=other"],
      repository: "acme/web",
    }),
  );
});

for (const host of ["github.com", "enterprise.test"]) {
  it.effect(`routes node-ID mutations through the discovered account on ${host}`, () =>
    Effect.gen(function* () {
      const token = "other-account-token";
      const reads: string[] = [];
      const mutations: Array<{ readonly query: string; readonly account: string }> = [];
      const run: VcsProcess.VcsProcess["Service"]["run"] = (input) => {
        if (input.command === "git") {
          // The checkout belongs to a different owner than the PR being reviewed.
          return Effect.succeed(output(`origin\tgit@${host}:personal/project.git (fetch)\n`));
        }
        if (input.args[0] === "auth") {
          return Effect.succeed(
            output(
              input.args[1] === "token"
                ? token
                : encodeJson({
                    hosts: {
                      [host]: [
                        { login: "main", active: true, state: "success", host },
                        { login: "work", active: false, state: "success", host },
                      ],
                    },
                  }),
            ),
          );
        }
        const account =
          (host === "github.com" ? input.env?.GH_TOKEN : input.env?.GH_ENTERPRISE_TOKEN) === token
            ? "work"
            : "main";
        const query =
          input.stdin === undefined
            ? (input.args.find((arg) => arg.startsWith("query="))?.slice(6) ?? "")
            : decodeRequest(input.stdin).query;
        if (query.startsWith("mutation")) mutations.push({ query, account });
        else reads.push(account);
        if (account === "main") {
          return Effect.fail(
            new VcsProcessExitError({
              operation: input.operation,
              command: "gh",
              cwd: input.cwd,
              exitCode: 1,
              failureKind: "not-found",
              detail: "Process exited with a non-zero status.",
            }),
          );
        }
        return Effect.succeed(output('{"data":{"repository":{"pullRequest":{"id":"PR_7"}}}}'));
      };
      const github = yield* GitHubCli.make.pipe(
        Effect.provideService(VcsProcess.VcsProcess, { run }),
      );
      const cli = yield* GitHubPullRequestCli.make.pipe(
        Effect.provideService(GitHubCli.GitHubCli, github),
      );
      const input = { cwd: "/personal", host, repository: "acme/web" };

      // A repository read discovers the only account with access before node-only writes.
      yield* github.execute({
        cwd: input.cwd,
        args: [
          "api",
          "graphql",
          "--hostname",
          host,
          "-f",
          "owner=acme",
          "-f",
          'query=query { repository(owner: "acme", name: "web") { id } }',
        ],
      });
      assert.deepStrictEqual(reads, ["main", "work"]);
      yield* cli.replyToReviewThread({
        ...input,
        threadId: "PRRT_1",
        body: "Fixed using repo:other/library.",
      });
      yield* cli.setReviewThreadResolution({ ...input, threadId: "PRRT_1", resolved: true });
      yield* cli.setReviewThreadResolution({ ...input, threadId: "PRRT_1", resolved: false });
      yield* cli.setPullRequestFilesViewed({
        ...input,
        number: 7,
        files: [{ path: "src/a.ts", viewed: true }],
      });
      yield* cli.setPullRequestFilesViewed({
        ...input,
        number: 7,
        files: [{ path: "src/a.ts", viewed: false }],
      });

      assert.deepStrictEqual(
        mutations.map(({ account }) => account),
        ["work", "work", "work", "work", "work"],
      );
      for (const { query } of mutations) {
        assert.notInclude(query, "owner:");
      }
    }).pipe(Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer))),
  );
}
