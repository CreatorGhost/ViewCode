import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationThreadShell,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type PullRequestSubmitReviewInput,
  type ReviewFinding,
  type ReviewPostFindingsInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as PullRequestService from "../pullRequest/PullRequestService.ts";
import * as ReviewFindingsPoster from "./ReviewFindingsPoster.ts";

const PROJECT_ID = ProjectId.make("project-1");
const REVIEW_THREAD_ID = ThreadId.make("review-thread");
const FINDINGS_ACTIVITY_ID = EventId.make("findings-activity");
const TARGET = {
  kind: "pull-request",
  host: "github.com",
  repository: "octo/app",
  number: 42,
  url: "https://github.com/octo/app/pull/42",
} as const;

const reviewThread = {
  id: REVIEW_THREAD_ID,
  projectId: PROJECT_ID,
} as OrchestrationThreadShell;

// Two slices, the way a host hands over a large diff.
const SLICES: Record<string, PullRequestDiffResult> = {
  first: {
    patch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,2 +1,3 @@",
      " keep",
      "+added",
      " keep",
      "",
    ].join("\n"),
    truncated: false,
    nextCursor: "second",
  },
  second: {
    patch: [
      "diff --git a/src/b.ts b/src/b.ts",
      "--- a/src/b.ts",
      "+++ b/src/b.ts",
      "@@ -5 +5 @@",
      "-old",
      "+new",
      "",
    ].join("\n"),
    truncated: false,
    nextCursor: null,
  },
};

const finding = (overrides: Partial<ReviewFinding>): ReviewFinding => ({
  severity: "important",
  confidence: 95,
  path: "src/a.ts",
  title: "A problem",
  detail: "This breaks when the list is empty.",
  ...overrides,
});

const input = (overrides: Partial<ReviewPostFindingsInput> = {}): ReviewPostFindingsInput => ({
  reviewThreadId: REVIEW_THREAD_ID,
  findingsActivityId: FINDINGS_ACTIVITY_ID,
  target: TARGET,
  verdict: "request-changes",
  overallComment: "A couple of things before this goes in.",
  findings: [
    { key: "finding:0", finding: finding({ line: 2 }) },
    { key: "finding:1", finding: finding({ path: "src/b.ts", line: 5 }) },
    { key: "finding:2", finding: finding({ line: 30, title: "Off the diff" }) },
    { key: "check:0", finding: finding({ path: "README.md", title: "No line" }) },
  ],
  ...overrides,
});

const makeHarness = (
  options: {
    readonly submitFails?: PullRequestService.PullRequestError;
    readonly diffFails?: boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const reviews = yield* Ref.make<ReadonlyArray<PullRequestSubmitReviewInput>>([]);
    const diffs = yield* Ref.make<ReadonlyArray<PullRequestDiffInput>>([]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(threadId === REVIEW_THREAD_ID ? Option.some(reviewThread) : Option.none()),
      }),
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        withRoutingCredential: (_reference, operation) => operation,
        diff: (request) =>
          Ref.update(diffs, (all) => [...all, request]).pipe(
            Effect.andThen(
              options.diffFails === true
                ? Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }))
                : Effect.succeed(SLICES[request.cursor ?? "first"]!),
            ),
          ),
        submitReview: (request) =>
          Ref.update(reviews, (all) => [...all, request]).pipe(
            Effect.andThen(
              options.submitFails === undefined ? Effect.void : Effect.fail(options.submitFails),
            ),
          ),
      }),
    );
    const service = yield* ReviewFindingsPoster.ReviewFindingsPoster.pipe(
      Effect.provide(ReviewFindingsPoster.layer.pipe(Layer.provide(dependencies))),
    );
    return { service, commands, reviews, diffs };
  });

describe("ReviewFindingsPoster", () => {
  it.effect("posts one review with the findings on their lines and the rest in its text", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.service.post(input({ expectedAccountId: "account-1" }));

      expect(result).toEqual({
        url: TARGET.url,
        findings: [
          { key: "finding:0", placement: "inline" },
          { key: "finding:1", placement: "inline" },
          { key: "finding:2", placement: "body" },
          { key: "check:0", placement: "body" },
        ],
      });
      expect((yield* Ref.get(harness.diffs)).map((request) => request.cursor)).toEqual([
        undefined,
        "second",
      ]);
      const reviews = yield* Ref.get(harness.reviews);
      expect(reviews).toHaveLength(1);
      const [review] = reviews;
      expect(review).toMatchObject({
        projectId: PROJECT_ID,
        host: "github.com",
        repository: "octo/app",
        number: 42,
        expectedAccountId: "account-1",
        verdict: "request-changes",
        comments: [
          { path: "src/a.ts", position: { kind: "added", newLine: 2 } },
          { path: "src/b.ts", position: { kind: "added", newLine: 5 } },
        ],
      });
      expect(review?.body.startsWith("A couple of things before this goes in.")).toBe(true);
      expect(review?.body).toContain("**Off the diff** (`src/a.ts:30`)");
      expect(review?.body).toContain("**No line** (`README.md`)");

      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.activity.append",
          threadId: REVIEW_THREAD_ID,
          activity: {
            kind: "viewcode.review.posted",
            payload: {
              findingsActivityId: FINDINGS_ACTIVITY_ID,
              verdict: "request-changes",
              url: TARGET.url,
              findings: result.findings,
            },
          },
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("puts every finding in the text when the diff cannot be read", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ diffFails: true });
      const result = yield* harness.service.post(input());
      expect(result.findings.every((entry) => entry.placement === "body")).toBe(true);
      expect((yield* Ref.get(harness.reviews))[0]?.comments).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("says what the host refused and records nothing as posted", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        submitFails: new PullRequestOperationError({
          operation: "submitReview",
          detail: "You need write access on this repository to request changes.",
        }),
      });
      const error = yield* harness.service.post(input()).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ReviewPostFindingsError", stage: "submit" });
      expect(error.message).toBe(
        "Could not post the review: You need write access on this repository to request changes.",
      );
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a review too long for the host before sending it", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const long = finding({ detail: "x".repeat(1_500), suggestedFix: "y".repeat(1_500) });
      const error = yield* harness.service
        .post(
          input({
            findings: Array.from({ length: 30 }, (_, index) => ({
              key: `finding:${index}`,
              finding: long,
            })),
          }),
        )
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ReviewPostFindingsError", stage: "too-long" });
      expect(yield* Ref.get(harness.reviews)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("fails without posting when the review thread is gone", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness.service
        .post(input({ reviewThreadId: ThreadId.make("gone") }))
        .pipe(Effect.flip);
      expect(error).toMatchObject({ stage: "review-thread" });
      expect(yield* Ref.get(harness.reviews)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
