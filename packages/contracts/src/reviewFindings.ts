import * as Schema from "effect/Schema";

import { PositiveInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The machine-readable half of an agent review: what the reviewer hands ViewCode with
 * `submit_review_findings` after writing its report. The server records it on the review thread
 * as a `REVIEW_FINDINGS_ACTIVITY_KIND` activity; clients render the latest one as a card whose
 * findings can be sent to a coding session to fix.
 *
 * The bounds keep a full "Fix all" message (every finding at its longest) under
 * `PROVIDER_SEND_TURN_MAX_INPUT_CHARS`, so a fix never fails for being too long.
 */
export const REVIEW_FINDINGS_ACTIVITY_KIND = "viewcode.review.findings";

export const REVIEW_FINDINGS_MAX_FINDINGS = 30;
export const REVIEW_FINDINGS_MAX_NEEDS_CHECKING = 20;
export const REVIEW_FINDING_MAX_TITLE_CHARS = 200;
export const REVIEW_FINDING_MAX_PATH_CHARS = 300;
export const REVIEW_FINDING_MAX_DETAIL_CHARS = 1_500;
export const REVIEW_FINDING_MAX_SUGGESTED_FIX_CHARS = 1_500;
export const REVIEW_FINDING_MAX_RULE_CHARS = 200;

export const ReviewFindingSeverity = Schema.Literals(["blocker", "important", "nit", "question"]);
export type ReviewFindingSeverity = typeof ReviewFindingSeverity.Type;

export const ReviewVerdict = Schema.Literals(["approve", "approve-with-nits", "request-changes"]);
export type ReviewVerdict = typeof ReviewVerdict.Type;

const bounded = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const ReviewFinding = Schema.Struct({
  severity: ReviewFindingSeverity,
  /** 0-100: 100 is proven from the code, 50 plausible but unverified. */
  confidence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  /** Repository-relative path of the file the finding is about. */
  path: bounded(REVIEW_FINDING_MAX_PATH_CHARS),
  line: Schema.optional(PositiveInt),
  endLine: Schema.optional(PositiveInt),
  title: bounded(REVIEW_FINDING_MAX_TITLE_CHARS),
  /** The problem, why it matters and the path from a caller or input to it. */
  detail: bounded(REVIEW_FINDING_MAX_DETAIL_CHARS),
  /** A code block the author could apply as it stands; untrimmed, indentation is code. */
  suggestedFix: Schema.optional(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(REVIEW_FINDING_MAX_SUGGESTED_FIX_CHARS),
    ),
  ),
  /** The repository rule the finding breaks, quoted. */
  rule: Schema.optional(bounded(REVIEW_FINDING_MAX_RULE_CHARS)),
  /** The problem was there before the change; the change makes it worse or reachable. */
  preExisting: Schema.optional(Schema.Boolean),
}).check(
  Schema.makeFilter(
    (finding) =>
      finding.endLine === undefined ||
      (finding.line !== undefined && finding.endLine >= finding.line) ||
      "endLine needs a line at or before it.",
  ),
);
export type ReviewFinding = typeof ReviewFinding.Type;

/** What the reviewer submits. */
export const ReviewFindingsReport = Schema.Struct({
  verdict: ReviewVerdict,
  /** 0-5: 5 is safe to merge as is, 0 will break something. */
  mergeConfidence: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 })),
  /** 1-5: how long a careful human review takes. */
  reviewEffort: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5 })),
  findings: Schema.Array(ReviewFinding).check(Schema.isMaxLength(REVIEW_FINDINGS_MAX_FINDINGS)),
  needsChecking: Schema.Array(ReviewFinding).check(
    Schema.isMaxLength(REVIEW_FINDINGS_MAX_NEEDS_CHECKING),
  ),
});
export type ReviewFindingsReport = typeof ReviewFindingsReport.Type;

/** What was reviewed: the review thread's linked pull request, or its own checkout. */
export const ReviewFindingsTarget = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("pull-request"),
    host: Schema.String,
    repository: Schema.String,
    number: PositiveInt,
    url: Schema.String,
  }),
  Schema.Struct({ kind: Schema.Literal("local") }),
]);
export type ReviewFindingsTarget = typeof ReviewFindingsTarget.Type;

/**
 * What the reader does with the findings: fix them (their own pull request, or a local review), or
 * post them as review comments (somebody else's pull request).
 */
export const ReviewFindingsMode = Schema.Literals(["fix", "comment"]);
export type ReviewFindingsMode = typeof ReviewFindingsMode.Type;

/** The `REVIEW_FINDINGS_ACTIVITY_KIND` activity payload. */
export const ReviewFindingsActivityPayload = Schema.Struct({
  ...ReviewFindingsReport.fields,
  target: ReviewFindingsTarget,
  /** Decided when the findings are recorded. Absent on findings from before it existed: "fix". */
  mode: Schema.optional(ReviewFindingsMode),
});
export type ReviewFindingsActivityPayload = typeof ReviewFindingsActivityPayload.Type;

/** One finding sent to be fixed; a needs-checking item says so, since nobody settled it. */
export const ReviewFindingToFix = Schema.Struct({
  finding: ReviewFinding,
  needsChecking: Schema.Boolean,
});
export type ReviewFindingToFix = typeof ReviewFindingToFix.Type;

/** At most a full review's findings, so the message stays under the turn input limit. */
export const ReviewFindingsToFix = Schema.Array(ReviewFindingToFix).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(REVIEW_FINDINGS_MAX_FINDINGS),
);

/**
 * Starts a session that fixes findings from a review thread: a new thread on the pull request's
 * head in a worktree of its own (linked to the pull request), or on the review thread's checkout
 * for a local review.
 */
export const ReviewStartFixThreadInput = Schema.Struct({
  reviewThreadId: ThreadId,
  target: ReviewFindingsTarget,
  findings: ReviewFindingsToFix,
});
export type ReviewStartFixThreadInput = typeof ReviewStartFixThreadInput.Type;

export const ReviewStartFixThreadResult = Schema.Struct({
  threadId: ThreadId,
  title: TrimmedNonEmptyString,
});
export type ReviewStartFixThreadResult = typeof ReviewStartFixThreadResult.Type;

export class ReviewFixThreadError extends Schema.TaggedError<ReviewFixThreadError>()(
  "ReviewFixThreadError",
  {
    stage: Schema.Literals([
      "review-thread",
      "project",
      "settings",
      "checkout",
      "create-thread",
      "link",
      "start-turn",
    ]),
    /** What the checkout reported, which is the only way to know what to do about it. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "review-thread":
        return "The review thread was not found.";
      case "project":
        return "The review's project was not found.";
      case "settings":
        return "Could not read the default settings for new threads.";
      case "checkout":
        return this.detail
          ? `Could not check out the pull request: ${this.detail}`
          : "Could not check out the pull request.";
      case "create-thread":
        return "Could not create the session.";
      case "link":
        return "The session was created, but the pull request could not be linked to it.";
      case "start-turn":
        return "The session was created, but the findings could not be sent to it.";
    }
  }
}
