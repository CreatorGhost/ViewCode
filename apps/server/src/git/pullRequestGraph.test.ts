import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";

const testLayer = GitWorkflowService.layer.pipe(
  Layer.provide(
    Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
      detect: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
    }),
  ),
  Layer.provide(Layer.mock(GitManager.GitManager)({})),
  Layer.provideMerge(GitVcsDriver.layer),
  Layer.provideMerge(VcsProcess.layer),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-pr-graph-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provideMerge(NodeServices.layer),
);

const lines = (count: number, label: (index: number) => string) =>
  Array.from({ length: count }, (_, index) => label(index + 1)).join("\n") + "\n";

describe("GitWorkflowService.pullRequestGraph", () => {
  it.effect(
    "reads the branch, the base since the fork and where they clash, leaving the checkout alone",
    () =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const driver = yield* GitVcsDriver.GitVcsDriver;
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pr-graph-" });
        let clock = Date.parse("2026-10-01T10:00:00Z");
        const git = (args: ReadonlyArray<string>, author?: string) => {
          clock += 60_000;
          const at = DateTime.formatIso(DateTime.makeUnsafe(clock));
          return driver.execute({
            operation: "test.prGraph",
            cwd,
            args: author === undefined ? args : ["-c", `user.name=${author}`, ...args],
            allowNonZeroExit: true,
            env: { ...process.env, GIT_AUTHOR_DATE: at, GIT_COMMITTER_DATE: at },
          });
        };
        const write = (file: string, content: string) =>
          fileSystem.writeFileString(path.join(cwd, file), content);
        const commit = (subject: string, author: string) =>
          git(["add", "-A"]).pipe(
            Effect.andThen(git(["commit", "-q", "-m", subject], author)),
            Effect.andThen(git(["rev-parse", "HEAD"])),
            Effect.map((result) => result.stdout.trim()),
          );

        yield* git(["init", "-q", "-b", "main"]);
        yield* git(["config", "user.email", "dev@example.com"]);
        yield* git(["config", "user.name", "You"]);
        yield* git(["remote", "add", "origin", "https://example.invalid/acme/app.git"]);
        yield* write(
          "middleware.ts",
          lines(24, (n) => `const line${n} = ${n};`),
        );
        yield* write(
          "auth.ts",
          lines(80, (n) => `export const a${n} = ${n};`),
        );
        const forkSha = yield* commit("Bump next to 16.3", "Sam");

        yield* git(["checkout", "-q", "-b", "feat/session-refresh"]);
        yield* write(
          "middleware.ts",
          lines(24, (n) =>
            n === 18
              ? "if (nearExpiry(session)) await refresh(session);"
              : `const line${n} = ${n};`,
          ),
        );
        yield* commit("Refresh sessions near expiry", "You");
        // Five separate clashes in auth.ts, each eight lines a side: more than the hunks shown.
        yield* write(
          "auth.ts",
          lines(80, (n) =>
            n % 16 >= 1 && n % 16 <= 8
              ? `export const a${n} = "ours";`
              : `export const a${n} = ${n};`,
          ),
        );
        yield* write("session.test.ts", "test('refresh', () => {});\n");
        const headTip = yield* commit("Add session refresh tests", "You");

        yield* git(["checkout", "-q", "main"]);
        yield* write(
          "middleware.ts",
          lines(24, (n) =>
            n === 18 ? "const session = await readSession(req, keys);" : `const line${n} = ${n};`,
          ),
        );
        const rotateSha = yield* commit("Rotate session keys", "Lena");
        yield* write(
          "auth.ts",
          lines(80, (n) =>
            n % 16 >= 1 && n % 16 <= 8
              ? `export const a${n} = "theirs";`
              : `export const a${n} = ${n};`,
          ),
        );
        const keysSha = yield* commit("Read sessions with the current key", "Lena");
        yield* git(["update-ref", "refs/remotes/origin/main", "main"]);
        yield* git(["update-ref", "refs/remotes/origin/feat/session-refresh", headTip]);
        yield* git(["checkout", "-q", "feat/session-refresh"]);

        const input = { cwd, baseBranch: "main", headBranch: "feat/session-refresh" };
        const statusBefore = (yield* git(["status", "--porcelain=v1", "--untracked-files=all"]))
          .stdout;
        const graph = yield* workflow.pullRequestGraph(input);
        assert.isNotNull(graph);
        if (graph === null) return;

        assert.deepStrictEqual(
          graph.head.map((commit) => [commit.subject, commit.authorName, commit.lane]),
          [
            ["Add session refresh tests", "You", "head"],
            ["Refresh sessions near expiry", "You", "head"],
          ],
        );
        assert.include(graph.head[0]?.refs ?? [], "feat/session-refresh");
        assert.deepStrictEqual(
          graph.base.map((commit) => [commit.sha, commit.subject, commit.lane]),
          [
            [keysSha, "Read sessions with the current key", "base"],
            [rotateSha, "Rotate session keys", "base"],
          ],
        );
        assert.include(graph.base[0]?.refs ?? [], "main");
        assert.strictEqual(graph.mergeBase, forkSha);
        assert.strictEqual(graph.fork?.subject, "Bump next to 16.3");
        assert.strictEqual(graph.viewerName, "You");
        assert.isFalse(graph.merged);
        assert.isNull(graph.resolving);

        const files = graph.conflicts?.files ?? [];
        assert.deepStrictEqual(
          files.map((file) => [
            file.path,
            file.count,
            file.baseCommits,
            file.theirsAuthor,
            file.oursAuthor,
          ]),
          [
            ["auth.ts", 5, [keysSha], "Lena", "You"],
            ["middleware.ts", 1, [rotateSha], "Lena", "You"],
          ],
        );
        const middleware = files[1];
        assert.deepStrictEqual(middleware?.hunks, [
          {
            line: 18,
            ours: ["if (nearExpiry(session)) await refresh(session);"],
            theirs: ["const session = await readSession(req, keys);"],
          },
        ]);
        const auth = files[0];
        assert.strictEqual(auth?.hunks.length, 3);
        assert.isTrue(
          auth?.hunks.every((hunk) => hunk.ours.length === 6 && hunk.theirs.length === 6),
        );
        assert.isBelow(JSON.stringify(graph).length, 16 * 1024);

        // Nothing in the checkout moved: no files, no index, no merge state.
        assert.strictEqual(
          (yield* git(["status", "--porcelain=v1", "--untracked-files=all"])).stdout,
          statusBefore,
        );
        assert.strictEqual((yield* git(["rev-parse", "HEAD"])).stdout.trim(), headTip);
        assert.notStrictEqual(
          (yield* git(["rev-parse", "-q", "--verify", "MERGE_HEAD"])).exitCode,
          0,
        );

        // The agent starts the merge: both files conflict, then it fixes one.
        yield* git(["merge", "--no-edit", "origin/main"]);
        const merging = yield* workflow.pullRequestGraph(input);
        assert.deepStrictEqual(merging?.resolving, {
          total: 2,
          unresolved: ["auth.ts", "middleware.ts"],
        });
        yield* write(
          "middleware.ts",
          lines(24, (n) => `const line${n} = ${n};`),
        );
        yield* git(["add", "middleware.ts"]);
        const halfway = yield* workflow.pullRequestGraph(input);
        assert.deepStrictEqual(halfway?.resolving, { total: 2, unresolved: ["auth.ts"] });

        // Committed: the clash is gone and the base commits read as merged into the branch.
        yield* write(
          "auth.ts",
          lines(80, (n) => `export const a${n} = ${n};`),
        );
        yield* git(["add", "auth.ts"]);
        yield* git(["commit", "-q", "--no-edit"], "You");
        const resolved = yield* workflow.pullRequestGraph(input);
        assert.isNull(resolved?.resolving);
        assert.deepStrictEqual(resolved?.conflicts, { files: [], truncated: false });
        assert.strictEqual(resolved?.mergeBase, forkSha);
        assert.deepStrictEqual(
          resolved?.base.map((commit) => [commit.subject, commit.inHead]),
          [
            ["Read sessions with the current key", true],
            ["Rotate session keys", true],
          ],
        );
        assert.strictEqual(resolved?.head[0]?.parents.length, 2);

        // Merged on the host with a merge commit: the branch is part of the base now, and still
        // reads as its own commits against the base as it was just before.
        const mergedHead = (yield* git(["rev-parse", "HEAD"])).stdout.trim();
        yield* git(["checkout", "-q", "main"]);
        yield* git(["merge", "-q", "--no-ff", "--no-edit", "feat/session-refresh"], "Lena");
        yield* git(["update-ref", "refs/remotes/origin/main", "main"]);
        yield* git(["checkout", "-q", "feat/session-refresh"]);
        const merged = yield* workflow.pullRequestGraph(input);
        assert.isTrue(merged?.merged);
        assert.strictEqual(merged?.head[0]?.sha, mergedHead);
        assert.strictEqual(merged?.head.length, 3);
        assert.strictEqual(merged?.mergeBase, forkSha);
        assert.deepStrictEqual(merged?.conflicts, { files: [], truncated: false });
      }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("has nothing to show for branches the checkout does not know", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-pr-graph-" });
      yield* driver.execute({ operation: "test.prGraph", cwd, args: ["init", "-q", "-b", "main"] });
      const graph = yield* workflow.pullRequestGraph({
        cwd,
        baseBranch: "main",
        headBranch: "feat/missing",
      });
      assert.isNull(graph);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});
