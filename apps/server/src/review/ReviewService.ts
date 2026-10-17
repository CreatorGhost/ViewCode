import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import {
  VcsRepositoryDetectionError,
  VcsUnsupportedOperationError,
  type ReviewDiffFileContentsInput,
  type ReviewDiffFileContentsResult,
  type ReviewDiffPreviewError,
  type ReviewDiffPreviewInput,
  type ReviewDiffPreviewResult,
  REVIEW_LIST_COMMITS_MAX,
  type ReviewListCommitsInput,
  type ReviewListCommitsResult,
} from "@t3tools/contracts";

import * as ServerConfig from "../config.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as KnownWorkspaces from "../workspace/KnownWorkspaces.ts";

// Fields split by the unit separator, commits by the record separator: neither occurs in a
// subject or a name.
const REVIEW_COMMIT_FORMAT = "%H%x1f%h%x1f%s%x1f%an%x1f%cI%x1e";

/** Commits as `git log --format=REVIEW_COMMIT_FORMAT` prints them, newest first. */
export function parseReviewCommitLog(stdout: string): ReviewListCommitsResult["commits"] {
  return stdout.split("\x1e").flatMap((record) => {
    const [sha, shortSha, subject, author, committedAt] = record.trim().split("\x1f");
    if (!sha || !shortSha || committedAt === undefined) return [];
    return [{ sha, shortSha, subject: subject ?? "", author: author ?? "", committedAt }];
  });
}

export class ReviewService extends Context.Service<
  ReviewService,
  {
    readonly getDiffPreview: (
      input: ReviewDiffPreviewInput,
    ) => Effect.Effect<ReviewDiffPreviewResult, ReviewDiffPreviewError>;
    readonly getDiffFileContents: (
      input: ReviewDiffFileContentsInput,
    ) => Effect.Effect<ReviewDiffFileContentsResult, ReviewDiffPreviewError>;
    readonly listCommits: (
      input: ReviewListCommitsInput,
    ) => Effect.Effect<ReviewListCommitsResult, ReviewDiffPreviewError>;
  }
>()("t3/review/ReviewService") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const vcsRegistry = yield* VcsDriverRegistry.VcsDriverRegistry;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const knownWorkspaces = yield* KnownWorkspaces.KnownWorkspaces;

  const canonicalizePath = (value: string) => {
    const resolvedPath = path.resolve(value);
    return fileSystem.realPath(resolvedPath).pipe(
      Effect.catchTags({
        PlatformError: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(resolvedPath)
            : Effect.fail(
                new VcsRepositoryDetectionError({
                  operation: "ReviewService.assertWorkspaceBoundCwd.canonicalizePath",
                  cwd: resolvedPath,
                  detail: "Failed to resolve a path while validating the review workspace.",
                  cause,
                }),
              ),
      }),
    );
  };

  const assertWorkspaceBoundCwd = Effect.fn("ReviewService.assertWorkspaceBoundCwd")(function* (
    operation:
      | "ReviewService.getDiffPreview"
      | "ReviewService.getDiffFileContents"
      | "ReviewService.listCommits",
    cwd: string,
  ) {
    const [candidate, workspaceRoot] = yield* Effect.all([
      canonicalizePath(cwd),
      canonicalizePath(config.cwd),
    ]);
    if (
      KnownWorkspaces.isWithinRoot(path, candidate, workspaceRoot) ||
      (yield* knownWorkspaces.contains(candidate))
    ) {
      return;
    }

    return yield* new VcsRepositoryDetectionError({
      operation,
      cwd,
      detail:
        operation === "ReviewService.getDiffPreview"
          ? "Review diff preview cwd must stay within the configured workspace root."
          : "Review diff file contents cwd must stay within the configured workspace root.",
    });
  });

  const getDiffPreview: ReviewService["Service"]["getDiffPreview"] = Effect.fn(
    "ReviewService.getDiffPreview",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffPreview", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (!handle) {
      return {
        cwd: input.cwd,
        generatedAt: yield* DateTime.now,
        sources: [],
      };
    }

    const getDriverDiffPreview = handle.driver.getDiffPreview;
    if (!getDriverDiffPreview) {
      if (handle.kind === "git") {
        return yield* git.getReviewDiffPreview(input);
      }
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffPreview",
        kind: handle.kind,
        detail: `The ${handle.kind} VCS driver does not support review diff previews.`,
      });
    }

    return yield* getDriverDiffPreview(input);
  });

  const getDiffFileContents: ReviewService["Service"]["getDiffFileContents"] = Effect.fn(
    "ReviewService.getDiffFileContents",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.getDiffFileContents", input.cwd);

    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") {
      return yield* new VcsUnsupportedOperationError({
        operation: "ReviewService.getDiffFileContents",
        kind: handle?.kind ?? "unknown",
        detail: "Unchanged diff expansion currently requires a Git repository.",
      });
    }

    return yield* git.getReviewDiffFileContents(input);
  });

  const listCommits: ReviewService["Service"]["listCommits"] = Effect.fn(
    "ReviewService.listCommits",
  )(function* (input) {
    yield* assertWorkspaceBoundCwd("ReviewService.listCommits", input.cwd);
    const handle = yield* vcsRegistry.detect({ cwd: input.cwd, requestedKind: "auto" });
    if (handle?.kind !== "git") return { commits: [], base: null };
    const log = yield* git.execute({
      operation: "ReviewService.listCommits",
      cwd: input.cwd,
      args: [
        "log",
        `--max-count=${input.limit ?? REVIEW_LIST_COMMITS_MAX}`,
        "--no-color",
        `--format=${REVIEW_COMMIT_FORMAT}`,
        "HEAD",
        "--",
      ],
      // A repository without commits has no HEAD to list from.
      allowNonZeroExit: true,
      maxOutputBytes: 256 * 1024,
    });
    // The remote's default branch, which a branch review without a named base diffs against.
    const base = yield* git.execute({
      operation: "ReviewService.listCommits.base",
      cwd: input.cwd,
      args: ["rev-parse", "--abbrev-ref", "origin/HEAD"],
      allowNonZeroExit: true,
    });
    const baseRef = base.exitCode === 0 ? base.stdout.trim() : "";
    return {
      commits: log.exitCode === 0 ? parseReviewCommitLog(log.stdout) : [],
      base: baseRef.length > 0 && baseRef !== "origin/HEAD" ? baseRef : null,
    };
  });

  return ReviewService.of({
    getDiffPreview,
    getDiffFileContents,
    listCommits,
  });
});

export const layer = Layer.effect(ReviewService, make);
