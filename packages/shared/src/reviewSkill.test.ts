import {
  EventId,
  ProjectId,
  REVIEW_FINDING_RATING_ACTIVITY_KIND,
  type ReviewFindingRatingActivityPayload,
  type ReviewSkill,
  ReviewSkill as ReviewSkillSchema,
  SubmitReviewSkillInput,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vitest";

import {
  applyReviewSkillRatings,
  editReviewSkill,
  mergeLearnedReviewSkill,
  reviewSkillForReviewer,
  reviewSkillLessonId,
  reviewSkillRatingCounts,
} from "./reviewSkill.ts";

const projectId = ProjectId.make("project-1");
const at = {
  projectId,
  learningThreadId: ThreadId.make("thread-1"),
  learnedAt: Schema.decodeSync(ReviewSkillSchema.fields.learnedAt)("2026-11-10T10:00:00.000Z")!,
};
const decodeLearned = Schema.decodeUnknownSync(SubmitReviewSkillInput);
const learned = (...texts: ReadonlyArray<string>) =>
  decodeLearned({
    summary: "Reviewers here ask for migrations to be reversible.",
    lessons: texts.map((text) => ({ text, source: "kept-breaking", occurrences: 3 })),
  });
const edited = (skill: ReviewSkill, edit: Parameters<typeof editReviewSkill>[1]): ReviewSkill => {
  const next = editReviewSkill(skill, edit);
  if (typeof next === "string") throw new Error(next);
  return next;
};
const rating = (
  key: string,
  value: "up" | "down" | null,
  lessonId: string | undefined,
  project = projectId,
) => ({
  kind: REVIEW_FINDING_RATING_ACTIVITY_KIND,
  payload: {
    findingsActivityId: EventId.make("findings-1"),
    key: key as ReviewFindingRatingActivityPayload["key"],
    rating: value,
    projectId: project,
    finding: {
      title: "A finding",
      severity: "nit",
      path: "a.ts",
      ...(lessonId === undefined ? {} : { lessonId }),
    },
  } satisfies ReviewFindingRatingActivityPayload,
});

describe("reviewSkillLessonId", () => {
  it("makes the same id from the same words and a new one when taken", () => {
    expect(reviewSkillLessonId("NOT NULL columns need a backfill")).toBe(
      "not-null-columns-need-a-backfill",
    );
    expect(reviewSkillLessonId("Hello!", new Set(["hello"]))).toBe("hello-2");
    expect(reviewSkillLessonId("???")).toBe("lesson");
  });
});

describe("mergeLearnedReviewSkill", () => {
  it("keeps the user's own lessons and what they switched off when learning again", () => {
    const first = mergeLearnedReviewSkill(
      null,
      learned("Lock rows in one order", "Old lesson"),
      at,
    );
    const withOwn = edited(edited(first, { kind: "add", text: "Never log tokens" as never }), {
      kind: "set-enabled",
      lessonId: "lock-rows-in-one-order" as never,
      enabled: false,
    });

    const again = mergeLearnedReviewSkill(
      withOwn,
      learned("Lock rows in one order", "A new lesson"),
      at,
    );

    expect(again.lessons.map((lesson) => [lesson.id, lesson.source, lesson.enabled])).toEqual([
      ["never-log-tokens", "yours", true],
      ["lock-rows-in-one-order", "kept-breaking", false],
      ["a-new-lesson", "kept-breaking", true],
    ]);
    expect(again.status).toBe("learned");
  });

  it("counts the same words handed over twice as one lesson", () => {
    const skill = mergeLearnedReviewSkill(null, learned("Same", "same"), at);
    expect(skill.lessons).toHaveLength(1);
  });
});

describe("editReviewSkill", () => {
  it("refuses a lesson the skill does not hold", () => {
    const skill = mergeLearnedReviewSkill(null, learned("One"), at);
    expect(editReviewSkill(skill, { kind: "remove", lessonId: "two" as never })).toBe("lesson");
    expect(
      editReviewSkill(skill, { kind: "set-enabled", lessonId: "two" as never, enabled: true }),
    ).toBe("lesson");
  });

  it("removes a lesson", () => {
    const skill = mergeLearnedReviewSkill(null, learned("One", "Two"), at);
    expect(
      edited(skill, { kind: "remove", lessonId: "one" as never }).lessons.map((l) => l.id),
    ).toEqual(["two"]);
  });
});

describe("ratings", () => {
  const skill = mergeLearnedReviewSkill(null, learned("One", "Two"), at);

  it("counts each finding once as last rated, for this project only", () => {
    const counts = reviewSkillRatingCounts(
      [
        rating("finding:0", "down", "one"),
        rating("finding:0", "up", "one"),
        rating("finding:1", "down", "one"),
        rating("finding:2", "down", "two"),
        rating("finding:2", null, "two"),
        rating("finding:3", "down", "one", ProjectId.make("other")),
        rating("finding:4", "down", undefined),
      ],
      projectId,
    );
    expect(counts.get("one")).toEqual({ helpful: 1, unhelpful: 1 });
    expect(counts.get("two")).toBeUndefined();
  });

  it("switches a lesson off at three thumbs-down, once, and leaves the user's choice after", () => {
    const three = new Map([["one", { helpful: 0, unhelpful: 3 }]]);
    const off = applyReviewSkillRatings(skill, three);
    expect(off.lessons[0]).toMatchObject({ enabled: false, disabledByRatings: true, unhelpful: 3 });
    expect(off.lessons[1]).toMatchObject({ enabled: true });

    const backOn = edited(off, { kind: "set-enabled", lessonId: "one" as never, enabled: true });
    expect(backOn.lessons[0]?.disabledByRatings).toBeUndefined();
    const four = applyReviewSkillRatings(backOn, new Map([["one", { helpful: 0, unhelpful: 4 }]]));
    expect(four.lessons[0]).toMatchObject({ enabled: true, unhelpful: 4 });
  });

  it("keeps a lesson that was also found helpful", () => {
    const kept = applyReviewSkillRatings(skill, new Map([["one", { helpful: 1, unhelpful: 5 }]]));
    expect(kept.lessons[0]).toMatchObject({ enabled: true, helpful: 1 });
  });
});

describe("reviewSkillForReviewer", () => {
  it("hands over only the lessons that are on", () => {
    const skill = edited(mergeLearnedReviewSkill(null, learned("One", "Two"), at), {
      kind: "set-enabled",
      lessonId: "two" as never,
      enabled: false,
    });
    expect(reviewSkillForReviewer(skill).lessons.map((lesson) => lesson.id)).toEqual(["one"]);
  });
});
