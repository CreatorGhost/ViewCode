import * as Schema from "effect/Schema";

import { PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** The `REVIEW_FINDINGS_ACTIVITY_KIND` activity payload. */
export const ReviewFindingsActivityPayload = Schema.Struct({
  ...ReviewFindingsReport.fields,
  target: ReviewFindingsTarget,
});
export type ReviewFindingsActivityPayload = typeof ReviewFindingsActivityPayload.Type;
