import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ModelSelection } from "./modelSelection.ts";

/**
 * A project's review skill: what its own history teaches a reviewer, learned by an agent that
 * reads how its pull requests were reviewed and what had to be fixed after merging, and shaped by
 * how the user rates findings. Kept in the server's state directory, so it is the user's own and
 * not the repository's; every review of the project reads it.
 */
export const REVIEW_SKILL_MAX_LESSONS = 40;
export const REVIEW_SKILL_MAX_LESSON_CHARS = 200;
const REVIEW_SKILL_MAX_SUMMARY_CHARS = 4_000;
const REVIEW_SKILL_MAX_EVIDENCE = 6;
/** A learned lesson turned down this often, and never found helpful, is switched off. */
export const REVIEW_SKILL_UNHELPFUL_LIMIT = 3;

const bounded = (max: number) => TrimmedNonEmptyString.check(Schema.isMaxLength(max));

export const ReviewSkillLessonId = bounded(64).check(Schema.isPattern(/^[a-z0-9-]+$/));
export type ReviewSkillLessonId = typeof ReviewSkillLessonId.Type;

export const ReviewSkillEvidence = Schema.Struct({ label: bounded(40), url: bounded(500) });
export type ReviewSkillEvidence = typeof ReviewSkillEvidence.Type;

/**
 * Where a lesson came from: fixes the history shows being made after merging, what the
 * repository's reviewers ask for, or the user who wrote it.
 */
export const ReviewSkillLessonSource = Schema.Literals(["kept-breaking", "reviewers-ask", "yours"]);
export type ReviewSkillLessonSource = typeof ReviewSkillLessonSource.Type;

/** What the learning agent hands over for one lesson. */
export const ReviewSkillLearnedLesson = Schema.Struct({
  text: bounded(REVIEW_SKILL_MAX_LESSON_CHARS),
  /** Where it applies, as path globs. */
  where: Schema.optional(bounded(REVIEW_SKILL_MAX_LESSON_CHARS)),
  source: Schema.Literals(["kept-breaking", "reviewers-ask"]),
  /** How many times the history showed it. */
  occurrences: Schema.optional(PositiveInt),
  evidence: Schema.optional(
    Schema.Array(ReviewSkillEvidence).check(Schema.isMaxLength(REVIEW_SKILL_MAX_EVIDENCE)),
  ),
});
export type ReviewSkillLearnedLesson = typeof ReviewSkillLearnedLesson.Type;

export const ReviewSkillLesson = Schema.Struct({
  id: ReviewSkillLessonId,
  text: bounded(REVIEW_SKILL_MAX_LESSON_CHARS),
  where: Schema.optional(bounded(REVIEW_SKILL_MAX_LESSON_CHARS)),
  source: ReviewSkillLessonSource,
  occurrences: Schema.optional(PositiveInt),
  evidence: Schema.Array(ReviewSkillEvidence),
  /** Off: reviews are not told about it. */
  enabled: Schema.Boolean,
  /** Set when the user's own ratings switched it off, so the list can say so. */
  disabledByRatings: Schema.optional(Schema.Boolean),
  /** Findings that cited it and were rated up, and down. */
  helpful: NonNegativeInt,
  unhelpful: NonNegativeInt,
});
export type ReviewSkillLesson = typeof ReviewSkillLesson.Type;

export const ReviewSkill = Schema.Struct({
  projectId: ProjectId,
  /** `learning` while an agent reads the history; the lessons are those of the last time. */
  status: Schema.Literals(["learning", "learned"]),
  /** The thread that is learning or last learned, to open or stop. */
  learningThreadId: Schema.NullOr(ThreadId),
  learnedAt: Schema.NullOr(IsoDateTime),
  /** How this project is reviewed, in the learning agent's words. */
  summary: Schema.String.check(Schema.isMaxLength(REVIEW_SKILL_MAX_SUMMARY_CHARS)),
  lessons: Schema.Array(ReviewSkillLesson),
});
export type ReviewSkill = typeof ReviewSkill.Type;

export const ReviewSkillProjectInput = Schema.Struct({ projectId: ProjectId });
export type ReviewSkillProjectInput = typeof ReviewSkillProjectInput.Type;

export const ReviewLearnSkillInput = Schema.Struct({
  projectId: ProjectId,
  /**
   * Asked for by the client on its own when a project is opened, not by the user: the server
   * then learns only when it never did, nothing is learning, and its setting allows it.
   */
  auto: Schema.optional(Schema.Boolean),
  modelSelection: Schema.optional(ModelSelection),
});
export type ReviewLearnSkillInput = typeof ReviewLearnSkillInput.Type;

export const ReviewSkillEdit = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("set-enabled"),
    lessonId: ReviewSkillLessonId,
    enabled: Schema.Boolean,
  }),
  Schema.Struct({
    kind: Schema.Literal("add"),
    text: bounded(REVIEW_SKILL_MAX_LESSON_CHARS),
    where: Schema.optional(bounded(REVIEW_SKILL_MAX_LESSON_CHARS)),
  }),
  Schema.Struct({ kind: Schema.Literal("remove"), lessonId: ReviewSkillLessonId }),
]);
export type ReviewSkillEdit = typeof ReviewSkillEdit.Type;

export const ReviewEditSkillInput = Schema.Struct({ projectId: ProjectId, edit: ReviewSkillEdit });
export type ReviewEditSkillInput = typeof ReviewEditSkillInput.Type;

/** What the learning agent submits with `submit_review_skill`. */
export const SubmitReviewSkillInput = Schema.Struct({
  summary: Schema.String.check(Schema.isMaxLength(REVIEW_SKILL_MAX_SUMMARY_CHARS)),
  lessons: Schema.Array(ReviewSkillLearnedLesson).check(
    Schema.isMaxLength(REVIEW_SKILL_MAX_LESSONS),
  ),
});
export type SubmitReviewSkillInput = typeof SubmitReviewSkillInput.Type;

export class ReviewSkillError extends Schema.TaggedError<ReviewSkillError>()("ReviewSkillError", {
  stage: Schema.Literals([
    "project",
    "model",
    "read",
    "write",
    "lesson",
    "full",
    "start",
    "not-learning",
  ]),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    switch (this.stage) {
      case "project":
        return "The project was not found.";
      case "model":
        return "No model is set up to learn with.";
      case "read":
        return "Could not read the project's review skill.";
      case "write":
        return "Could not save the project's review skill.";
      case "lesson":
        return "That lesson is not part of this project's review skill.";
      case "full":
        return `A review skill holds at most ${REVIEW_SKILL_MAX_LESSONS} lessons.`;
      case "start":
        return "Could not start learning this project.";
      case "not-learning":
        return "This thread was not asked to learn the project's review skill.";
    }
  }
}
