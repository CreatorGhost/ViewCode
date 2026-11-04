import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  ProjectId,
  PullRequestOperationError,
  PullRequestUnavailableError,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type PullRequestDetail,
  type PullRequestDiffInput,
  type PullRequestDiffResult,
  type ReviewFinding,
  type ReviewPostFindingsInput,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ReviewActivityStoreV2 } from "./ReviewActivityStoreV2.ts";
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
} as OrchestrationV2ThreadShell;

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

const findingsActivity = (headSha: string | undefined) => ({
  id: FINDINGS_ACTIVITY_ID,
  tone: "info" as const,
  kind: "viewcode.review.findings",
  summary: "Review: request changes, 1 finding",
  payload: {
    verdict: "request-changes",
    mergeConfidence: 2,
    reviewEffort: 2,
    findings: [],
    needsChecking: [],
    target: TARGET,
    mode: "comment",
    ...(headSha === undefined ? {} : { headSha }),
  },
  turnId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
});

const makeHarness = (
  options: {
    readonly submitFails?: PullRequestService.PullRequestError;
    /** Refuse any review that carries line comments, the way a host refuses an unknown line. */
    readonly refuseLineComments?: boolean;
    readonly diffFails?: boolean;
    /** The head the findings were recorded against. */
    readonly reviewedHeadSha?: string;
    /** The pull request's head now. */
    readonly currentHeadSha?: string;
    readonly beforeFirstSubmit?: Effect.Effect<void>;
  } = {},
) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<
      ReadonlyArray<Parameters<ReviewActivityStoreV2["Service"]["append"]>[0]>
    >([]);
    const reviews = yield* Ref.make<
      ReadonlyArray<Parameters<PullRequestService.PullRequestService["Service"]["submitReview"]>[0]>
    >([]);
    const diffs = yield* Ref.make<ReadonlyArray<PullRequestDiffInput>>([]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: (threadId) =>
          Effect.succeed(threadId === REVIEW_THREAD_ID ? reviewThread : null),
      }),
      Layer.mock(ReviewActivityStoreV2)({
        list: (_threadId, kinds) =>
          Ref.get(commands).pipe(
            Effect.map((recorded) =>
              [
                findingsActivity(options.reviewedHeadSha),
                ...recorded.map((command) => command.activity),
              ].filter((activity) => kinds === undefined || kinds.includes(activity.kind)),
            ),
          ),
        append: (command) => Ref.update(commands, (all) => [...all, command]),
      }),
      Layer.mock(PullRequestService.PullRequestService)({
        withRoutingCredential: (_reference, operation) => operation,
        detail: () =>
          options.currentHeadSha === undefined
            ? Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" }))
            : Effect.succeed({ headSha: options.currentHeadSha } as PullRequestDetail),
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
              Effect.gen(function* () {
                if (
                  (yield* Ref.get(reviews)).length === 1 &&
                  options.beforeFirstSubmit !== undefined
                ) {
                  yield* options.beforeFirstSubmit;
                }
              }),
            ),
            Effect.andThen(
              options.submitFails !== undefined
                ? Effect.fail(options.submitFails)
                : options.refuseLineComments === true && request.comments.length > 0
                  ? Effect.fail(
                      new PullRequestOperationError({
                        operation: "submitReview",
                        detail: "Line could not be resolved",
                      }),
                    )
                  : Effect.void,
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
  it.effect(
    "filters posted keys from a stale selection and skips an entirely posted selection",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        const selection = input();
        yield* harness.service.post(input({ findings: selection.findings.slice(0, 1) }));
        const result = yield* harness.service.post(selection);
        expect(result.findings.map((entry) => entry.key)).toEqual([
          "finding:1",
          "finding:2",
          "check:0",
        ]);
        const reviews = yield* Ref.get(harness.reviews);
        expect(reviews).toHaveLength(2);
        expect(reviews[1]?.comments).toHaveLength(1);
        expect(reviews[1]?.comments[0]?.path).toBe("src/b.ts");

        const noOp = yield* harness.service.post(selection);
        expect(noOp.findings).toEqual([]);
        expect(yield* Ref.get(harness.reviews)).toHaveLength(2);
        expect(yield* Ref.get(harness.diffs)).toHaveLength(4);
        expect(yield* Ref.get(harness.commands)).toHaveLength(2);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "serializes overlapping submissions for the same findings set before reading posted keys",
    () =>
      Effect.gen(function* () {
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const harness = yield* makeHarness({
          beforeFirstSubmit: Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
          ),
        });
        const first = yield* harness.service.post(input()).pipe(Effect.forkChild);
        yield* Deferred.await(started);
        const second = yield* harness.service
          .post(input())
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.succeed(release, undefined);
        expect((yield* Fiber.join(first)).findings).toHaveLength(4);
        expect((yield* Fiber.join(second)).findings).toEqual([]);
        expect(yield* Ref.get(harness.reviews)).toHaveLength(1);
        expect(yield* Ref.get(harness.commands)).toHaveLength(1);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

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
        headMoved: false,
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

  it.effect("pins the review to the reviewed commit and says when the head moved since", () =>
    Effect.gen(function* () {
      const unmoved = yield* makeHarness({ reviewedHeadSha: "abc1234", currentHeadSha: "abc1234" });
      expect((yield* unmoved.service.post(input())).headMoved).toBe(false);
      expect((yield* Ref.get(unmoved.reviews))[0]?.commitId).toBe("abc1234");

      const moved = yield* makeHarness({ reviewedHeadSha: "abc1234", currentHeadSha: "def5678" });
      const result = yield* moved.service.post(input());
      expect(result.headMoved).toBe(true);
      const [review] = yield* Ref.get(moved.reviews);
      // Still on the reviewed commit, inline where the diff shows the line.
      expect(review?.commitId).toBe("abc1234");
      expect(review?.comments).toHaveLength(2);
      expect((yield* Ref.get(moved.commands))[0]).toMatchObject({
        activity: { payload: { headSha: "abc1234", headMoved: true } },
      });

      // Findings recorded without a commit post against the head, as before.
      const unpinned = yield* makeHarness({ currentHeadSha: "def5678" });
      expect((yield* unpinned.service.post(input())).headMoved).toBe(false);
      expect((yield* Ref.get(unpinned.reviews))[0]?.commitId).toBeUndefined();
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("moves every finding into the text when the moved head refuses a line", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        reviewedHeadSha: "abc1234",
        currentHeadSha: "def5678",
        refuseLineComments: true,
      });
      const result = yield* harness.service.post(input());
      expect(result.findings.every((entry) => entry.placement === "body")).toBe(true);
      const reviews = yield* Ref.get(harness.reviews);
      expect(reviews.map((review) => review.comments.length)).toEqual([2, 0]);
      expect(reviews[1]?.commitId).toBe("abc1234");

      // An unmoved head is not retried: the refusal is reported.
      const unmoved = yield* makeHarness({
        reviewedHeadSha: "abc1234",
        currentHeadSha: "abc1234",
        refuseLineComments: true,
      });
      const error = yield* unmoved.service.post(input()).pipe(Effect.flip);
      expect(error).toMatchObject({ stage: "submit" });
      expect(yield* Ref.get(unmoved.reviews)).toHaveLength(1);
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
