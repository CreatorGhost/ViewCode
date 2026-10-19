import {
  PullRequestOperationError,
  ReviewStartError,
  WS_METHODS,
  type PullRequestStartReviewInput,
  type ReviewStartLocalInput,
  type ReviewStartFixThreadInput,
  type ReviewUndoFixesInput,
  type ReviewPostFindingsInput,
  type ReviewRateFindingInput,
  type LearnedReviewStyleAccount,
  type ReviewListCommitsInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as PullRequestAgentReview from "../pullRequest/PullRequestAgentReview.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as LearnedReviewStyles from "../review/LearnedReviewStyles.ts";
import * as ReviewFindingRatings from "../review/ReviewFindingRatings.ts";
import * as ReviewFindingsPoster from "../review/ReviewFindingsPoster.ts";
import * as ReviewFixThread from "../review/ReviewFixThread.ts";
import * as ReviewService from "../review/ReviewService.ts";

export const make = Effect.gen(function* () {
  const reviews = yield* PullRequestAgentReview.PullRequestAgentReview;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const fixes = yield* ReviewFixThread.ReviewFixThread;
  const poster = yield* ReviewFindingsPoster.ReviewFindingsPoster;
  const ratings = yield* ReviewFindingRatings.ReviewFindingRatings;
  const styles = yield* LearnedReviewStyles.LearnedReviewStyles;
  const review = yield* ReviewService.ReviewService;

  return {
    [WS_METHODS.pullRequestsStartReview]: (input: PullRequestStartReviewInput) => {
      const {
        mode,
        modelSelection,
        focus,
        findingsMode,
        incremental,
        basedOn,
        sourceThreadId,
        ...reference
      } = input;
      return pullRequests
        .withRoutingCredential(
          reference,
          reviews.start({
            reference,
            mode,
            modelSelection,
            focus,
            findingsMode,
            incremental,
            basedOn,
            sourceThreadId,
            linkSource: "manual",
          }),
        )
        .pipe(
          Effect.catchTags({
            PullRequestAgentReviewError: (error) =>
              Effect.fail(
                new PullRequestOperationError({
                  operation: "startReview",
                  detail: error.message,
                  cause: error,
                }),
              ),
          }),
        );
    },
    [WS_METHODS.reviewListCommits]: (input: ReviewListCommitsInput) => review.listCommits(input),
    [WS_METHODS.reviewStartLocal]: (input: ReviewStartLocalInput) =>
      reviews
        .startLocal(input)
        .pipe(
          Effect.mapError((error) => new ReviewStartError({ detail: error.message, cause: error })),
        ),
    [WS_METHODS.reviewStartFixThread]: (input: ReviewStartFixThreadInput) => fixes.start(input),
    [WS_METHODS.reviewUndoFixes]: (input: ReviewUndoFixesInput) => fixes.undo(input),
    [WS_METHODS.reviewPostFindings]: (input: ReviewPostFindingsInput) => poster.post(input),
    [WS_METHODS.reviewRateFinding]: (input: ReviewRateFindingInput) => ratings.rate(input),
    [WS_METHODS.reviewGetLearnedStyle]: (input: LearnedReviewStyleAccount) => styles.status(input),
    [WS_METHODS.reviewLearnStyle]: (input: LearnedReviewStyleAccount) => styles.learn(input),
    [WS_METHODS.reviewForgetLearnedStyle]: (input: LearnedReviewStyleAccount) =>
      styles.forget(input),
  };
});
