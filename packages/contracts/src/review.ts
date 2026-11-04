import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { GitCommandError } from "./git.ts";
import { VcsError } from "./vcs.ts";

export const ReviewDiffPreviewInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  baseRef: Schema.optional(TrimmedNonEmptyString),
  /**
   * The end of the branch range instead of HEAD: `baseRef...headRef`, such as one commit's
   * `<sha>^...<sha>`. Older servers ignore it and diff against HEAD; clients send it only to
   * servers advertising `localAgentReviewScope`.
   */
  headRef: Schema.optional(TrimmedNonEmptyString),
  ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  file: Schema.optionalKey(
    Schema.Struct({
      path: Schema.NonEmptyString,
      previousPath: Schema.NullOr(Schema.NonEmptyString),
      sourceKind: Schema.Literals(["working-tree", "branch-range"]),
    }),
  ),
});
export type ReviewDiffPreviewInput = typeof ReviewDiffPreviewInput.Type;

export const ReviewDiffPreviewSourceKind = Schema.Literals(["working-tree", "branch-range"]);
export type ReviewDiffPreviewSourceKind = typeof ReviewDiffPreviewSourceKind.Type;

export const ReviewDiffFileStat = Schema.Struct({
  path: Schema.String,
  previousPath: Schema.NullOr(Schema.String),
  additions: Schema.Number,
  deletions: Schema.Number,
});
export type ReviewDiffFileStat = typeof ReviewDiffFileStat.Type;

export const ReviewDiffPreviewSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: ReviewDiffPreviewSourceKind,
  title: TrimmedNonEmptyString,
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  diff: Schema.String,
  diffHash: TrimmedNonEmptyString,
  truncated: Schema.Boolean,
  files: Schema.optionalKey(Schema.Array(ReviewDiffFileStat)),
});
export type ReviewDiffPreviewSource = typeof ReviewDiffPreviewSource.Type;

export const ReviewDiffFileContentsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  sourceKind: ReviewDiffPreviewSourceKind,
  changeType: Schema.Literals(["change", "rename-pure", "rename-changed", "new", "deleted"]),
  baseRef: Schema.NullOr(TrimmedNonEmptyString),
  headRef: Schema.NullOr(TrimmedNonEmptyString),
  oldPath: TrimmedNonEmptyString,
  newPath: TrimmedNonEmptyString,
});
export type ReviewDiffFileContentsInput = typeof ReviewDiffFileContentsInput.Type;

export const ReviewDiffFileContentsResult = Schema.Struct({
  oldContents: Schema.String,
  newContents: Schema.String,
});
export type ReviewDiffFileContentsResult = typeof ReviewDiffFileContentsResult.Type;

export const ReviewDiffPreviewResult = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  generatedAt: Schema.DateTimeUtc,
  sources: Schema.Array(ReviewDiffPreviewSource),
});
export type ReviewDiffPreviewResult = typeof ReviewDiffPreviewResult.Type;

export const ReviewDiffPreviewError = Schema.Union([VcsError, GitCommandError]);
export type ReviewDiffPreviewError = typeof ReviewDiffPreviewError.Type;

/** At most this many commits are listed for a reader to pick one to review. */
export const REVIEW_LIST_COMMITS_MAX = 50;

/**
 * The latest commits of a checkout, for picking one to review (`LocalReviewScope` "commit").
 * Only for servers advertising `localAgentReviewScope`.
 */
export const ReviewListCommitsInput = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  /** Default and most: `REVIEW_LIST_COMMITS_MAX`. */
  limit: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: REVIEW_LIST_COMMITS_MAX })),
  ),
});
export type ReviewListCommitsInput = typeof ReviewListCommitsInput.Type;

export const ReviewCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  shortSha: TrimmedNonEmptyString,
  subject: Schema.String,
  author: Schema.String,
  /** ISO 8601, for clients to show as a relative date. */
  committedAt: Schema.String,
});
export type ReviewCommit = typeof ReviewCommit.Type;

export const ReviewListCommitsResult = Schema.Struct({
  /** Newest first, from HEAD. */
  commits: Schema.Array(ReviewCommit),
  /**
   * The branch a branch review diffs against when none is named (the remote's default branch,
   * such as `origin/main`); null when the checkout has none.
   */
  base: Schema.NullOr(TrimmedNonEmptyString),
});
export type ReviewListCommitsResult = typeof ReviewListCommitsResult.Type;
