import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import * as GitHubCli from "../sourceControl/GitHubCli.ts";
import * as GitHubGraphQlBudget from "../sourceControl/githubGraphQlBudget.ts";
import * as SourceControlRateLimit from "../sourceControl/SourceControlRateLimit.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as LearnedReviewStyles from "./LearnedReviewStyles.ts";

const TOKEN = "gho_freelance_secret";
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

const output = (stdout: string): VcsProcess.VcsProcessOutput => ({
  exitCode: ChildProcessSpawner.ExitCode(0),
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
});

const reviewsOf = (login: string, comment: string) =>
  JSON.stringify({
    data: {
      viewer: {
        login,
        contributionsCollection: {
          pullRequestReviewContributions: {
            nodes: [
              {
                pullRequestReview: {
                  body: "",
                  state: "COMMENTED",
                  createdAt: "2026-09-01T00:00:00Z",
                  comments: { nodes: [{ body: comment, createdAt: "2026-09-01T00:00:00Z" }] },
                },
              },
            ],
          },
        },
      },
    },
  });

/**
 * gh signed in to github.com as `main` (active) and `freelance`. A command answers as the
 * account its environment's token belongs to, or as `ambient` when the server has a token of
 * its own that gh prefers to the active account.
 */
const makeHarness = (options: { readonly ambientToken?: boolean } = {}) =>
  Effect.gen(function* () {
    const calls: Array<VcsProcess.VcsProcessInput> = [];
    const run: VcsProcess.VcsProcess["Service"]["run"] = (input) => {
      calls.push(input);
      const [command, action] = input.args;
      if (command === "auth" && action === "status") {
        return Effect.succeed(
          output(
            JSON.stringify({
              hosts: {
                "github.com": [
                  { state: "success", host: "github.com", login: "main", active: true },
                  { state: "success", host: "github.com", login: "freelance", active: false },
                ],
              },
            }),
          ),
        );
      }
      if (command === "auth" && action === "token") return Effect.succeed(output(`${TOKEN}\n`));
      const as =
        input.env?.GH_TOKEN === TOKEN ? "freelance" : options.ambientToken ? "ambient" : "main";
      return Effect.succeed(output(reviewsOf(as, `How ${as} writes: why not a Set here?`)));
    };
    const github = yield* GitHubCli.make.pipe(
      Effect.provideService(VcsProcess.VcsProcess, { run }),
      Effect.provide(Layer.merge(GitHubGraphQlBudget.layer, SourceControlRateLimit.layer)),
    );
    const { styles, config } = yield* Effect.all({
      styles: LearnedReviewStyles.LearnedReviewStyles,
      config: ServerConfig.ServerConfig,
    }).pipe(
      Effect.provide(
        LearnedReviewStyles.layer.pipe(
          Layer.provide(Layer.succeed(GitHubCli.GitHubCli, github)),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-learned-review-style-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    );
    return { styles, stateDir: config.stateDir, calls };
  });

const graphQlCalls = (calls: ReadonlyArray<VcsProcess.VcsProcessInput>) =>
  calls.filter((call) => call.args[0] === "api" && call.args[1] === "graphql");

describe("LearnedReviewStyles", () => {
  it.effect("reads another signed-in account's reviews as that account and keeps them apart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const fs = yield* FileSystem.FileSystem;
      const freelance = { host: "GitHub.com", login: "Freelance" };
      expect(yield* harness.styles.status(freelance)).toBeNull();

      const learned = yield* harness.styles.learn(freelance);
      expect(learned.sampleCount).toBe(1);
      expect(learned.preview[0]?.text).toBe("How freelance writes: why not a Set here?");

      // The token went only into that one command's environment, never into any argv.
      const [read] = graphQlCalls(harness.calls);
      expect(read?.env?.GH_TOKEN).toBe(TOKEN);
      for (const call of harness.calls) expect(call.args.join(" ")).not.toContain(TOKEN);

      // The active account answers as itself, with no token of ours.
      yield* harness.styles.learn({ host: "github.com", login: "main" });
      expect(graphQlCalls(harness.calls)[1]?.env?.GH_TOKEN).toBeUndefined();

      const file = yield* decodeJson(
        yield* fs.readFileString(`${harness.stateDir}/review-style/github.com/freelance.json`),
      );
      expect(file).toMatchObject({
        host: "github.com",
        login: "freelance",
        samples: [{ kind: "inline", state: "commented" }],
      });
      expect((yield* harness.styles.status(freelance))?.preview[0]?.text).toContain("freelance");
      expect(
        (yield* harness.styles.status({ host: "github.com", login: "main" }))?.preview[0]?.text,
      ).toContain("main");

      // A reviewer finds the file only for an account something was learned for.
      const find = (login: string) =>
        LearnedReviewStyles.findLearnedReviewStyleFile({
          stateDir: harness.stateDir,
          account: { host: "github.com", login },
        });
      expect(yield* find("FREELANCE")).toBe(
        `${harness.stateDir}/review-style/github.com/freelance.json`,
      );
      expect(yield* find("octocat")).toBeNull();

      yield* harness.styles.forget(freelance);
      expect(yield* harness.styles.status(freelance)).toBeNull();
      expect(yield* find("freelance")).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses an account that is not signed in, or that gh does not answer as", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const missing = yield* harness.styles
        .learn({ host: "github.com", login: "octocat" })
        .pipe(Effect.flip);
      expect(missing).toMatchObject({ _tag: "LearnedReviewStyleError", stage: "account" });
      expect(graphQlCalls(harness.calls)).toEqual([]);

      const ambient = yield* makeHarness({ ambientToken: true });
      const mismatch = yield* ambient.styles
        .learn({ host: "github.com", login: "main" })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({ _tag: "LearnedReviewStyleError", stage: "account" });
      expect(yield* ambient.styles.status({ host: "github.com", login: "main" })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
