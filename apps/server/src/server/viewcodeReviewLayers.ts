import * as Layer from "effect/Layer";

import * as PullRequestAgentReview from "../pullRequest/PullRequestAgentReview.ts";
import * as LearnedReviewStyles from "../review/LearnedReviewStyles.ts";
import * as ReviewActivityStore from "../review/ReviewActivityStoreV2.ts";
import * as ReviewFindingRatings from "../review/ReviewFindingRatings.ts";
import * as ReviewFindingsPoster from "../review/ReviewFindingsPoster.ts";
import * as ReviewFixThread from "../review/ReviewFixThread.ts";

// These share the same canonical v2 event sink and projection instances as the orchestrator.
// The caller supplies the existing native runtime and PullRequestService layers.
export const layer = Layer.mergeAll(
  PullRequestAgentReview.layer.pipe(Layer.provideMerge(ReviewFindingRatings.layer)),
  ReviewFixThread.layer,
  ReviewFindingsPoster.layer,
  LearnedReviewStyles.layer,
).pipe(Layer.provideMerge(ReviewActivityStore.layer));
