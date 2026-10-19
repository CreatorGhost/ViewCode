import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as ServerConfig from "../config.ts";
import * as GitHubRest from "@t3tools/source-control-github/server/GitHubRest";
import * as TestSourceControlHost from "@t3tools/source-control-testing/TestSourceControlHost";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as LearnedReviewStyles from "./LearnedReviewStyles.ts";

const TOKEN = "gho_freelance_secret";
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));

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

const makeHarness = (options: { readonly ambientToken?: boolean } = {}) =>
  Effect.gen(function* () {
    const calls: Array<{ args: ReadonlyArray<string> }> = [];
    const reads: Array<{ account: string; token: string }> = [];
    const sourceHost = TestSourceControlHost.layer({
      process: {
        run: (input) =>
          Effect.sync(() => {
            calls.push(input);
            const account = input.args.includes("--user")
              ? input.args[input.args.indexOf("--user") + 1]?.toLowerCase()
              : "main";
            if (account !== "main" && account !== "freelance")
              return TestSourceControlHost.processOutput("", {
                exitCode: ChildProcessSpawner.ExitCode(1),
              });
            return TestSourceControlHost.processOutput(
              account === "freelance" ? TOKEN : "credential-main",
            );
          }),
      },
    });
    const http = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        const token = request.headers.authorization?.replace("Bearer ", "") ?? "";
        const account = options.ambientToken ? "ambient" : token === TOKEN ? "freelance" : "main";
        reads.push({ account, token });
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            new Response(reviewsOf(account, `How ${account} writes: why not a Set here?`), {
              headers: { "content-type": "application/json" },
            }),
          ),
        );
      }),
    );
    const dependencies = GitHubRest.layerWithDependencies.pipe(
      Layer.provideMerge(sourceHost),
      Layer.provideMerge(http),
      Layer.provide(NodeCrypto.layer),
    );
    const { styles, config } = yield* Effect.all({
      styles: LearnedReviewStyles.LearnedReviewStyles,
      config: ServerConfig.ServerConfig,
    }).pipe(
      Effect.provide(
        LearnedReviewStyles.layer.pipe(
          Layer.provide(dependencies),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-learned-review-style-" }).pipe(
              Layer.provideMerge(NodeServices.layer),
            ),
          ),
        ),
      ),
    );
    return { styles, stateDir: config.stateDir, calls, reads };
  });

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

      // The selected token reaches only the API request, never a command argument.
      expect(harness.reads[0]?.token).toBe(TOKEN);
      for (const call of harness.calls) expect(call.args.join(" ")).not.toContain(TOKEN);

      // An explicit account remains scoped to its own request.
      yield* harness.styles.learn({ host: "github.com", login: "main" });
      expect(harness.reads[1]?.account).toBe("main");

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
      expect(harness.reads).toEqual([]);

      const ambient = yield* makeHarness({ ambientToken: true });
      const mismatch = yield* ambient.styles
        .learn({ host: "github.com", login: "main" })
        .pipe(Effect.flip);
      expect(mismatch).toMatchObject({ _tag: "LearnedReviewStyleError", stage: "account" });
      expect(yield* ambient.styles.status({ host: "github.com", login: "main" })).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
