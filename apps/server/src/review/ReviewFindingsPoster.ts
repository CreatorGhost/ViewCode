import {
  CommandId,
  EventId,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  ReviewPostFindingsError,
  type PullRequestRef,
  type ReviewFindingsPostedActivityPayload,
  type ReviewPostFindingsInput,
  type ReviewPostFindingsResult,
} from "@t3tools/contracts";
import {
  type ReviewCommentableLines,
  buildReviewFromFindings,
  postedReviewFindings,
  readReviewFindings,
  reviewCommentableLines,
} from "@t3tools/shared/reviewFindings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";

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
 *
 * A review pinned to the commit it read is posted against that commit, so its comments sit on the
 * lines the reviewer saw even after the pull request moved on (the host marks them outdated where
 * a line changed since). Which lines take a comment is read from the current diff, the only one a
 * host serves; when the head moved and the host refuses the review over a line, it is sent again
 * with every finding in its text.
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
  const postingGates = new Map<string, { readonly gate: Semaphore.Semaphore; pending: number }>();

  const inPostingOrder = (
    input: ReviewPostFindingsInput,
    operation: Effect.Effect<ReviewPostFindingsResult, ReviewPostFindingsError>,
  ) =>
    Effect.suspend(() => {
      const key = `${input.reviewThreadId.length}:${input.reviewThreadId}:${input.findingsActivityId}`;
      const held = postingGates.get(key);
      const entry = held ?? { gate: Semaphore.makeUnsafe(1), pending: 0 };
      if (held === undefined) postingGates.set(key, entry);
      entry.pending += 1;
      return entry.gate
        .withPermits(1)(operation)
        .pipe(
          Effect.ensuring(
            Effect.sync(() => {
              entry.pending -= 1;
              if (entry.pending === 0) postingGates.delete(key);
            }),
          ),
        );
    });

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

  const currentHeadSha = (reference: PullRequestRef) =>
    pullRequests.detail(reference).pipe(
      Effect.map((detail) => detail.headSha),
      Effect.orElseSucceed(() => undefined),
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

    const detail = yield* snapshots
      .getThreadDetailById(input.reviewThreadId, {
        activityKinds: [REVIEW_FINDINGS_ACTIVITY_KIND, REVIEW_FINDINGS_POSTED_ACTIVITY_KIND],
        allActivities: true,
      })
      .pipe(
        Effect.mapError((cause) => new ReviewPostFindingsError({ stage: "review-thread", cause })),
      );
    if (Option.isNone(detail)) {
      return yield* new ReviewPostFindingsError({ stage: "review-thread" });
    }
    const posted = postedReviewFindings(detail.value.activities, input.findingsActivityId);
    const findingsToPost = input.findings.filter(({ key }) => !posted.has(key));
    if (findingsToPost.length === 0) {
      return { url: target.url, findings: [], headMoved: false };
    }
    // Read from the server's own record, not from the client, so a post cannot be pinned elsewhere.
    const activity = detail.value.activities.find((entry) => entry.id === input.findingsActivityId);
    const headSha = activity === undefined ? undefined : readReviewFindings(activity)?.headSha;
    const submitWith = (commentable: ReviewCommentableLines | null) =>
      Effect.gen(function* () {
        const review = buildReviewFromFindings({
          overallComment: input.overallComment,
          findings: findingsToPost,
          commentable,
        });
        if (review.body.length > REVIEW_BODY_MAX_CHARS) {
          return yield* new ReviewPostFindingsError({ stage: "too-long" });
        }
        yield* pullRequests.submitReview({
          ...reference,
          verdict: input.verdict,
          body: review.body,
          comments: review.comments,
          commitId: headSha,
        });
        return review.placements;
      });
    const submit = Effect.gen(function* () {
      const current = headSha === undefined ? undefined : yield* currentHeadSha(reference);
      const headMoved =
        headSha !== undefined &&
        current !== undefined &&
        current.toLowerCase() !== headSha.toLowerCase();
      const commentable = yield* commentableLines(reference);
      const placements = yield* headMoved && commentable !== null
        ? submitWith(commentable).pipe(
            Effect.catchTag("PullRequestOperationError", (error) =>
              Effect.logWarning("The host refused line comments on a review of an older commit", {
                detail: error.detail,
              }).pipe(Effect.andThen(submitWith(null))),
            ),
          )
        : submitWith(commentable);
      return { placements, headMoved };
    });
    const { placements: findings, headMoved } = yield* pullRequests
      .withRoutingCredential(reference, submit)
      .pipe(
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
      ...(headSha === undefined ? {} : { headSha, headMoved }),
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
    return { url: target.url, findings, headMoved };
  });

  // Keep the posted-key read, host submission and persisted receipt under the same gate.
  return ReviewFindingsPoster.of({ post: (input) => inPostingOrder(input, post(input)) });
});

export const layer = Layer.effect(ReviewFindingsPoster, make);
