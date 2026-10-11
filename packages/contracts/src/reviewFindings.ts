import * as Schema from "effect/Schema";

import {
  EventId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { PullRequestReviewVerdict } from "./pullRequest.ts";

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
/** Leaves room in a host's 65,536-character review for findings that have no line to sit on. */
export const REVIEW_POST_MAX_OVERALL_COMMENT_CHARS = 10_000;

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
export const ReviewPullRequestTarget = Schema.Struct({
  kind: Schema.Literal("pull-request"),
  host: Schema.String,
  repository: Schema.String,
  number: PositiveInt,
  url: Schema.String,
});
export type ReviewPullRequestTarget = typeof ReviewPullRequestTarget.Type;

export const ReviewFindingsTarget = Schema.Union([
  ReviewPullRequestTarget,
  Schema.Struct({ kind: Schema.Literal("local") }),
]);
export type ReviewFindingsTarget = typeof ReviewFindingsTarget.Type;

/**
 * What the reader does with the findings: fix them (their own pull request, or a local review), or
 * post them as review comments (somebody else's pull request).
 */
export const ReviewFindingsMode = Schema.Literals(["fix", "comment"]);
export type ReviewFindingsMode = typeof ReviewFindingsMode.Type;

/** A commit a review read, as the host names it. */
export const ReviewCommitSha = Schema.String.check(Schema.isPattern(/^[0-9a-f]{7,64}$/i));
export type ReviewCommitSha = typeof ReviewCommitSha.Type;

/**
 * Which earlier findings a re-review starts from, as the reader's client names them: the review
 * thread and its findings activity. The server reads the rest, the commit included, itself.
 */
export const ReviewBasedOnInput = Schema.Struct({
  threadId: ThreadId,
  activityId: EventId,
});
export type ReviewBasedOnInput = typeof ReviewBasedOnInput.Type;

/** The earlier findings a re-review started from, as recorded by the server. */
export const ReviewBasedOn = Schema.Struct({
  activityId: EventId,
  /** The commit the earlier review read; absent when it named none. */
  headSha: Schema.optional(ReviewCommitSha),
});
export type ReviewBasedOn = typeof ReviewBasedOn.Type;

/** What a re-review found of the earlier findings. */
export const ReviewPreviousSummary = Schema.Struct({
  fixed: NonNegativeInt,
  stillOpen: NonNegativeInt,
});
export type ReviewPreviousSummary = typeof ReviewPreviousSummary.Type;

/** The `REVIEW_FINDINGS_ACTIVITY_KIND` activity payload. */
export const ReviewFindingsActivityPayload = Schema.Struct({
  ...ReviewFindingsReport.fields,
  target: ReviewFindingsTarget,
  /** Decided when the findings are recorded. Absent on findings from before it existed: "fix". */
  mode: Schema.optional(ReviewFindingsMode),
  /**
   * The pull request's head commit the reviewer was asked to review, which posted comments are
   * pinned to. Absent for a local review, a host that did not say, and older findings.
   */
  headSha: Schema.optional(ReviewCommitSha),
  /**
   * A re-review: only what changed since `basedOn.headSha` was read, the earlier findings checked
   * again, and the unfixed ones carried into these.
   */
  incremental: Schema.optional(Schema.Boolean),
  basedOn: Schema.optional(ReviewBasedOn),
  /** How the earlier findings fared, as the re-review reported it. */
  previous: Schema.optional(ReviewPreviousSummary),
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

/**
 * Recorded on a review thread by the server when the review starts, so what the start knew (the
 * commit under review) reaches the findings recorded later. Hidden from the transcript.
 */
export const REVIEW_STARTED_ACTIVITY_KIND = "viewcode.review.started";

export const ReviewStartedActivityPayload = Schema.Struct({
  headSha: Schema.optional(ReviewCommitSha),
  incremental: Schema.optional(Schema.Boolean),
  basedOn: Schema.optional(ReviewBasedOn),
});
export type ReviewStartedActivityPayload = typeof ReviewStartedActivityPayload.Type;

/**
 * Recorded on the review thread once findings are posted, so every client knows which were and
 * nobody posts one twice.
 */
export const REVIEW_FINDINGS_POSTED_ACTIVITY_KIND = "viewcode.review.posted";

/** A finding's key on its card: which list it is in, and its index there. */
export const ReviewFindingKey = Schema.String.check(Schema.isPattern(/^(finding|check):\d{1,3}$/));
export type ReviewFindingKey = typeof ReviewFindingKey.Type;

/** Where a posted finding went: on its line of the diff, or into the review's own text. */
export const ReviewFindingPlacement = Schema.Literals(["inline", "body"]);
export type ReviewFindingPlacement = typeof ReviewFindingPlacement.Type;

export const ReviewPostedFinding = Schema.Struct({
  key: ReviewFindingKey,
  /** On its line of the diff, or in the review's text when the diff does not show that line. */
  placement: ReviewFindingPlacement,
});
export type ReviewPostedFinding = typeof ReviewPostedFinding.Type;

/** Posts findings to the reviewed pull request as one review, comments on their lines. */
export const ReviewPostFindingsInput = Schema.Struct({
  reviewThreadId: ThreadId,
  /** The findings activity they come from, which the posted record points back to. */
  findingsActivityId: EventId,
  target: ReviewPullRequestTarget,
  verdict: PullRequestReviewVerdict,
  /** The review's own words, above any finding that has no line to sit on. May be empty. */
  overallComment: Schema.String.check(Schema.isMaxLength(REVIEW_POST_MAX_OVERALL_COMMENT_CHARS)),
  findings: Schema.Array(Schema.Struct({ key: ReviewFindingKey, finding: ReviewFinding })).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(REVIEW_FINDINGS_MAX_FINDINGS + REVIEW_FINDINGS_MAX_NEEDS_CHECKING),
  ),
  /** Refuse unless this GitHub account still owns the credential, as the pull request page does. */
  expectedAccountId: Schema.optional(TrimmedNonEmptyString),
});
export type ReviewPostFindingsInput = typeof ReviewPostFindingsInput.Type;

export const ReviewPostFindingsResult = Schema.Struct({
  /** The pull request the review is on. */
  url: Schema.String,
  findings: Schema.Array(ReviewPostedFinding),
  /**
   * The pull request has commits the review did not read. Its comments are still pinned to the
   * reviewed commit, so the host may show them as outdated. Absent from older servers.
   */
  headMoved: Schema.optional(Schema.Boolean),
});
export type ReviewPostFindingsResult = typeof ReviewPostFindingsResult.Type;

/** The `REVIEW_FINDINGS_POSTED_ACTIVITY_KIND` activity payload. */
export const ReviewFindingsPostedActivityPayload = Schema.Struct({
  findingsActivityId: EventId,
  verdict: PullRequestReviewVerdict,
  url: Schema.String,
  findings: Schema.Array(ReviewPostedFinding),
  /** The commit the review was posted against, when the findings named one. */
  headSha: Schema.optional(ReviewCommitSha),
  headMoved: Schema.optional(Schema.Boolean),
});
export type ReviewFindingsPostedActivityPayload = typeof ReviewFindingsPostedActivityPayload.Type;

/**
 * A reader's thumbs up or down on one finding, recorded on the review thread so every client shows
 * it, and read back when later reviews of the project start: the reviewer is shown what was and was
 * not wanted. The latest rating of a finding wins; null takes it back.
 */
export const REVIEW_FINDING_RATING_ACTIVITY_KIND = "viewcode.review.rating";

export const ReviewFindingRating = Schema.Literals(["up", "down"]);
export type ReviewFindingRating = typeof ReviewFindingRating.Type;

export const ReviewRateFindingInput = Schema.Struct({
  reviewThreadId: ThreadId,
  findingsActivityId: EventId,
  findingKey: ReviewFindingKey,
  rating: Schema.NullOr(ReviewFindingRating),
});
export type ReviewRateFindingInput = typeof ReviewRateFindingInput.Type;

/** The `REVIEW_FINDING_RATING_ACTIVITY_KIND` activity payload. */
export const ReviewFindingRatingActivityPayload = Schema.Struct({
  findingsActivityId: EventId,
  key: ReviewFindingKey,
  rating: Schema.NullOr(ReviewFindingRating),
  /** Kept with the rating so later reviews of the project find it without reading the findings. */
  projectId: ProjectId,
  finding: Schema.Struct({
    title: Schema.String,
    severity: ReviewFindingSeverity,
    path: Schema.String,
    rule: Schema.optional(Schema.String),
  }),
});
export type ReviewFindingRatingActivityPayload = typeof ReviewFindingRatingActivityPayload.Type;

export class ReviewRateFindingError extends Schema.TaggedError<ReviewRateFindingError>()(
  "ReviewRateFindingError",
  {
    stage: Schema.Literals(["review-thread", "finding", "record"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "review-thread":
        return "The review thread was not found.";
      case "finding":
        return "That finding is not part of this review.";
      case "record":
        return "Could not save the rating.";
    }
  }
}

/**
 * A review is one request, so a failure applies to every finding it carried: none of them was
 * posted.
 */
export class ReviewPostFindingsError extends Schema.TaggedError<ReviewPostFindingsError>()(
  "ReviewPostFindingsError",
  {
    stage: Schema.Literals(["review-thread", "too-long", "submit"]),
    /** What the host said, which is the only way to know what to do about it. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "review-thread":
        return "The review thread was not found.";
      case "too-long":
        return "These findings make a review too long to post. Post fewer at once.";
      case "submit":
        return this.detail
          ? `Could not post the review: ${this.detail}`
          : "Could not post the review.";
    }
  }
}

/** Why a review could not be started, in words the reader can act on. */
export class ReviewStartError extends Schema.TaggedError<ReviewStartError>()("ReviewStartError", {
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

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

/**
 * Learned review style: an account's own recent review writing, read from the host as that
 * account and kept on the server, for a reviewer whose findings will be posted as that account
 * to imitate. GitHub only.
 */
export const LearnedReviewStyleAccount = Schema.Struct({
  /** A host name, with a port when it has one. */
  host: Schema.String.check(
    Schema.isMaxLength(255),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9.-]*(:\d{1,5})?$/),
  ),
  login: Schema.String.check(
    Schema.isMaxLength(100),
    Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/),
  ),
});
export type LearnedReviewStyleAccount = typeof LearnedReviewStyleAccount.Type;

/** A comment on a line of the diff, or the text of a whole review. */
export const LearnedReviewStyleSampleKind = Schema.Literals(["inline", "summary"]);
export type LearnedReviewStyleSampleKind = typeof LearnedReviewStyleSampleKind.Type;

/** The review a sample was written in, as it was submitted. */
export const LearnedReviewStyleSampleState = Schema.Literals([
  "approved",
  "changes-requested",
  "commented",
  "dismissed",
]);
export type LearnedReviewStyleSampleState = typeof LearnedReviewStyleSampleState.Type;

export const LearnedReviewStyleSample = Schema.Struct({
  kind: LearnedReviewStyleSampleKind,
  state: LearnedReviewStyleSampleState,
  text: Schema.String,
});
export type LearnedReviewStyleSample = typeof LearnedReviewStyleSample.Type;

/** What was learned for one account: how many samples, when, and a few to show the user. */
export const LearnedReviewStyle = Schema.Struct({
  sampleCount: NonNegativeInt,
  fetchedAt: IsoDateTime,
  preview: Schema.Array(LearnedReviewStyleSample),
});
export type LearnedReviewStyle = typeof LearnedReviewStyle.Type;

export class LearnedReviewStyleError extends Schema.TaggedError<LearnedReviewStyleError>()(
  "LearnedReviewStyleError",
  {
    stage: Schema.Literals(["account", "fetch", "store"]),
    /** What the host said, which is the only way to know what to do about it. */
    detail: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    switch (this.stage) {
      case "account":
        return "This account is not signed in to the GitHub CLI on the server.";
      case "fetch":
        return this.detail
          ? `Could not read your reviews: ${this.detail}`
          : "Could not read your reviews.";
      case "store":
        return "Could not read or save what was learned in the server's state directory.";
    }
  }
}
