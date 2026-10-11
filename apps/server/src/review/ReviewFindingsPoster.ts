import {
  CommandId,
  EventId,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  ReviewPostFindingsError,
  type PullRequestRef,
  type ReviewFindingsPostedActivityPayload,
  type ReviewPostFindingsInput,
  type ReviewPostFindingsResult,
} from "@t3tools/contracts";
import { buildReviewFromFindings, reviewCommentableLines } from "@t3tools/shared/reviewFindings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";

/** What the hosts take in a review's own text. */
const REVIEW_BODY_MAX_CHARS = 65_536;
/** A diff longer than this many slices is read no further; findings past it go in the text. */
const DIFF_MAX_SLICES = 20;

/**
 * Posts findings from an agent review to the reviewed pull request as one review, through the
 * same `PullRequestService.submitReview` the pull request page submits a review with: each
 * finding on its line where the diff shows that line, the rest in the review's text under the
 * reader's overall comment. Once posted, the review thread records which findings went, so every
 * client sees them as posted.
 */
export class ReviewFindingsPoster extends Context.Service<
  ReviewFindingsPoster,
  {
    readonly post: (
      input: ReviewPostFindingsInput,
    ) => Effect.Effect<ReviewPostFindingsResult, ReviewPostFindingsError>;
  }
>()("t3/review/ReviewFindingsPoster") {}

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const pullRequests = yield* PullRequestService.PullRequestService;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4.pipe(Effect.orDie);

  // A diff that cannot be read leaves every finding in the text, which no host refuses.
  const commentableLines = (reference: PullRequestRef) =>
    Effect.gen(function* () {
      const patches: Array<string> = [];
      let cursor: string | undefined;
      for (let slice = 0; slice < DIFF_MAX_SLICES; slice++) {
        const diff = yield* pullRequests.diff({
          ...reference,
          ...(cursor === undefined ? {} : { cursor }),
        });
        patches.push(diff.patch);
        if (diff.nextCursor === null) break;
        cursor = diff.nextCursor;
      }
      return reviewCommentableLines(patches.join("\n"));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not read the diff to place review comments on", {
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );

  const post = Effect.fn("ReviewFindingsPoster.post")(function* (input: ReviewPostFindingsInput) {
    const thread = yield* snapshots
      .getThreadShellById(input.reviewThreadId)
      .pipe(
        Effect.mapError((cause) => new ReviewPostFindingsError({ stage: "review-thread", cause })),
      );
    if (Option.isNone(thread)) {
      return yield* new ReviewPostFindingsError({ stage: "review-thread" });
    }
    const { target } = input;
    const reference: PullRequestRef = {
      projectId: thread.value.projectId,
      host: target.host,
      repository: target.repository,
      number: target.number,
      ...(input.expectedAccountId === undefined
        ? {}
        : { expectedAccountId: input.expectedAccountId }),
    };

    const submit = Effect.gen(function* () {
      const review = buildReviewFromFindings({
        overallComment: input.overallComment,
        findings: input.findings,
        commentable: yield* commentableLines(reference),
      });
      if (review.body.length > REVIEW_BODY_MAX_CHARS) {
        return yield* new ReviewPostFindingsError({ stage: "too-long" });
      }
      yield* pullRequests.submitReview({
        ...reference,
        verdict: input.verdict,
        body: review.body,
        comments: review.comments,
      });
      return review.placements;
    });
    const findings = yield* pullRequests.withRoutingCredential(reference, submit).pipe(
      Effect.mapError((error) =>
        error._tag === "ReviewPostFindingsError"
          ? error
          : new ReviewPostFindingsError({
              stage: "submit",
              detail: error._tag === "PullRequestOperationError" ? error.detail : error.message,
              cause: error,
            }),
      ),
    );

    // The review is on the host by now: failing to note it must not report it as not posted.
    const payload: ReviewFindingsPostedActivityPayload = {
      findingsActivityId: input.findingsActivityId,
      verdict: input.verdict,
      url: target.url,
      findings,
    };
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* engine
      .dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:review-posted:${thread.value.id}:${yield* uuid}`),
        threadId: thread.value.id,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
          summary: `Posted ${findings.length} ${findings.length === 1 ? "finding" : "findings"} to PR #${target.number}`,
          payload,
          turnId: null,
          createdAt,
        },
        createdAt,
      })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Posted review findings, but could not record it on the thread", {
            detail: error.message,
          }),
        ),
      );
    return { url: target.url, findings };
  });

  return ReviewFindingsPoster.of({ post });
});

export const layer = Layer.effect(ReviewFindingsPoster, make);
