import * as NodeServices from "@effect/platform-node/NodeServices";
import { EventId, ProjectId, ThreadId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ReviewActivityStoreV2 } from "./ReviewActivityStoreV2.ts";
import * as ReviewFindingRatings from "./ReviewFindingRatings.ts";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const PROJECT_ID = ProjectId.make("project-1");
const REVIEW_THREAD_ID = ThreadId.make("review-thread");

const findingsActivity: OrchestrationThreadActivity = {
  id: EventId.make("findings"),
  tone: "info",
  kind: "viewcode.review.findings",
  summary: "Review: approve with nits, 1 finding",
  payload: {
    verdict: "approve-with-nits",
    mergeConfidence: 4,
    reviewEffort: 1,
    findings: [
      {
        severity: "nit",
        confidence: 85,
        path: "src/a.ts",
        title: "Rename the flag",
        detail: "It reads as the opposite.",
        rule: "Name booleans for what is true.",
      },
    ],
    needsChecking: [],
    target: { kind: "local" },
  },
  turnId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
};

const makeHarness = (ratingActivities: ReadonlyArray<OrchestrationThreadActivity> = []) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<
      ReadonlyArray<Parameters<ReviewActivityStoreV2["Service"]["append"]>[0]>
    >([]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === REVIEW_THREAD_ID
              ? ({ id: REVIEW_THREAD_ID, projectId: PROJECT_ID } as never)
              : null,
          ),
      }),
      Layer.mock(ReviewActivityStoreV2)({
        list: () => Effect.succeed([findingsActivity]),
        listByKind: () => Effect.succeed(ratingActivities),
        append: (command) => Ref.update(commands, (all) => [...all, command]),
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-ratings-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    const { ratings, config } = yield* Effect.all({
      ratings: ReviewFindingRatings.ReviewFindingRatings,
      config: ServerConfig.ServerConfig,
    }).pipe(Effect.provide(ReviewFindingRatings.layer.pipe(Layer.provideMerge(dependencies))));
    return { ratings, commands, stateDir: config.stateDir };
  });

describe("ReviewFindingRatings", () => {
  it.effect("records a rating with the finding it is about, outside any turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      yield* harness.ratings.rate({
        reviewThreadId: REVIEW_THREAD_ID,
        findingsActivityId: EventId.make("findings"),
        findingKey: "finding:0",
        rating: "down",
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          threadId: REVIEW_THREAD_ID,
          activity: {
            kind: "viewcode.review.rating",
            turnId: null,
            payload: {
              findingsActivityId: "findings",
              key: "finding:0",
              rating: "down",
              projectId: PROJECT_ID,
              finding: {
                title: "Rename the flag",
                severity: "nit",
                path: "src/a.ts",
                rule: "Name booleans for what is true.",
              },
              timelineBypass: true,
            },
          },
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a finding the review does not have", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      for (const [findingsActivityId, findingKey] of [
        ["findings", "finding:1"],
        ["findings", "check:0"],
        ["elsewhere", "finding:0"],
      ] as const) {
        const error = yield* harness.ratings
          .rate({
            reviewThreadId: REVIEW_THREAD_ID,
            findingsActivityId: EventId.make(findingsActivityId),
            findingKey,
            rating: "up",
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ stage: "finding" });
      }
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("writes the project's rated findings for a review, and nothing when none", () =>
    Effect.gen(function* () {
      const rating = (projectId: string, rating: "up" | "down"): OrchestrationThreadActivity => ({
        id: EventId.make(`rating-${projectId}`),
        tone: "info",
        kind: "viewcode.review.rating",
        summary: "Rated a finding",
        payload: {
          findingsActivityId: "findings",
          key: "finding:0",
          rating,
          projectId,
          finding: { title: `In ${projectId}`, severity: "nit", path: "src/a.ts" },
        },
        turnId: null,
        createdAt: "2026-09-01T00:00:00.000Z",
      });
      const harness = yield* makeHarness([rating("project-1", "down"), rating("project-2", "up")]);
      const path = yield* harness.ratings.writeRatedFindingsFile(PROJECT_ID);
      expect(path).toBe(`${harness.stateDir}/review-ratings/project-1.json`);
      const written = decodeJson(yield* (yield* FileSystem.FileSystem).readFileString(path!));
      expect(written).toEqual({
        ratedFindings: [
          { rating: "down", title: "In project-1", severity: "nit", path: "src/a.ts" },
        ],
      });

      const empty = yield* makeHarness([rating("project-2", "up")]);
      expect(yield* empty.ratings.writeRatedFindingsFile(PROJECT_ID)).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
