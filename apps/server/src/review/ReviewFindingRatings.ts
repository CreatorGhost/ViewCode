import {
  CommandId,
  EventId,
  REVIEW_FINDING_RATING_ACTIVITY_KIND,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  ReviewRateFindingError,
  type ProjectId,
  type ReviewFindingRatingActivityPayload,
  type ReviewRateFindingInput,
} from "@t3tools/contracts";
import { readReviewFindings, recentRatedReviewFindings } from "@t3tools/shared/reviewFindings";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ReviewActivityStore from "../review/ReviewActivityStoreV2.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ReviewThreadContext from "../review/ReviewThreadContextV2.ts";

/** How many of the project's latest rated findings a review is shown. */
const RATED_FINDINGS_LIMIT = 30;
const RATED_FINDINGS_DIR = "review-ratings";
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/**
 * Ratings of review findings: kept as activities on the review thread, so every client shows the
 * same, and handed to later reviews of the project as a file the first message names.
 */
export class ReviewFindingRatings extends Context.Service<
  ReviewFindingRatings,
  {
    readonly rate: (input: ReviewRateFindingInput) => Effect.Effect<void, ReviewRateFindingError>;
    /**
     * Writes the project's latest rated findings for a reviewer to read and returns the file, or
     * null when nothing in the project was rated. Never fails: a review starts without them.
     */
    readonly writeRatedFindingsFile: (projectId: ProjectId) => Effect.Effect<string | null>;
  }
>()("t3/review/ReviewFindingRatings") {}

const make = Effect.gen(function* () {
  const activities = yield* ReviewActivityStore.ReviewActivityStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const readThread = (
    threadId: import("@t3tools/contracts").ThreadId,
    options?: { readonly activityKinds?: ReadonlyArray<string>; readonly allActivities?: boolean },
  ) =>
    ReviewThreadContext.read(threadId, options?.activityKinds).pipe(
      Effect.provideService(ProjectionStore.ProjectionStoreV2, projections),
      Effect.provideService(ReviewActivityStore.ReviewActivityStoreV2, activities),
    );
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  const rate = Effect.fn("ReviewFindingRatings.rate")(function* (input: ReviewRateFindingInput) {
    const thread = yield* readThread(input.reviewThreadId, {
      activityKinds: [REVIEW_FINDINGS_ACTIVITY_KIND],
    }).pipe(
      Effect.mapError((cause) => new ReviewRateFindingError({ stage: "review-thread", cause })),
    );
    if (Option.isNone(thread)) {
      return yield* new ReviewRateFindingError({ stage: "review-thread" });
    }
    const activity = thread.value.activities.find((entry) => entry.id === input.findingsActivityId);
    const payload = activity === undefined ? undefined : readReviewFindings(activity);
    const [list, index] = input.findingKey.split(":") as ["finding" | "check", string];
    const finding = (list === "finding" ? payload?.findings : payload?.needsChecking)?.[
      Number(index)
    ];
    if (finding === undefined) return yield* new ReviewRateFindingError({ stage: "finding" });

    const rating: ReviewFindingRatingActivityPayload = {
      findingsActivityId: input.findingsActivityId,
      key: input.findingKey,
      rating: input.rating,
      projectId: thread.value.projectId,
      finding: {
        title: finding.title,
        severity: finding.severity,
        path: finding.path,
        ...(finding.rule === undefined ? {} : { rule: finding.rule }),
      },
    };
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    yield* activities
      .append({
        commandId: CommandId.make(`server:review-rating:${thread.value.id}:${yield* uuid}`),
        threadId: thread.value.id,
        activity: {
          id: EventId.make(yield* uuid),
          tone: "info",
          kind: REVIEW_FINDING_RATING_ACTIVITY_KIND,
          summary: input.rating === null ? "Took back a finding's rating" : "Rated a finding",
          // Outside any turn, so reverting the review keeps what the reader thought of it.
          payload: { ...rating, timelineBypass: true },
          turnId: null,
          createdAt,
        },
      })
      .pipe(Effect.mapError((cause) => new ReviewRateFindingError({ stage: "record", cause })));
  });

  const writeRatedFindingsFile = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const records = yield* activities.listByKind(REVIEW_FINDING_RATING_ACTIVITY_KIND);
      const rated = recentRatedReviewFindings(records, projectId, RATED_FINDINGS_LIMIT);
      if (rated.length === 0) return null;
      const dir = path.join(config.stateDir, RATED_FINDINGS_DIR);
      const target = path.join(dir, `${projectId}.json`);
      // Reviews of one project start concurrently; a rename keeps every reader's file whole.
      const temporary = `${target}.${yield* uuid}.tmp`;
      yield* fileSystem.makeDirectory(dir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, encodeJson({ ratedFindings: rated }));
      yield* fileSystem.rename(temporary, target);
      return target;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not hand the project's rated findings to the review", {
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );

  return ReviewFindingRatings.of({ rate, writeRatedFindingsFile });
});

export const layer = Layer.effect(ReviewFindingRatings, make);
