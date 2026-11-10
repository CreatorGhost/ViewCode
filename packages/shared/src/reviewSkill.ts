/**
 * The rules of a project's review skill that need no I/O: how what a learning agent found is
 * merged into what the user already has, how the user's edits and ratings change it, and what a
 * reviewer is handed. The server keeps the file; see `ProjectReviewSkill.ts`.
 */
import {
  REVIEW_FINDING_RATING_ACTIVITY_KIND,
  REVIEW_SKILL_MAX_LESSONS,
  REVIEW_SKILL_UNHELPFUL_LIMIT,
  ReviewFindingRatingActivityPayload,
  type OrchestrationThreadActivity,
  type ReviewSkill,
  type ReviewSkillEdit,
  type ReviewSkillLearnedLesson,
  type ReviewSkillLesson,
  type SubmitReviewSkillInput,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeRating = Schema.decodeUnknownOption(ReviewFindingRatingActivityPayload);

/** A lesson's id from its words, so learning the same lesson again keeps the user's choices. */
export function reviewSkillLessonId(text: string, taken: ReadonlySet<string> = new Set()): string {
  const slug =
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 56)
      .replace(/-+$/, "") || "lesson";
  if (!taken.has(slug)) return slug;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${slug}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

const learnedLesson = (
  lesson: ReviewSkillLearnedLesson,
  id: string,
  before: ReviewSkillLesson | undefined,
): ReviewSkillLesson => ({
  id,
  text: lesson.text,
  ...(lesson.where === undefined ? {} : { where: lesson.where }),
  source: lesson.source,
  ...(lesson.occurrences === undefined ? {} : { occurrences: lesson.occurrences }),
  evidence: lesson.evidence ?? [],
  // Learning a lesson again must not switch back on what the user switched off.
  enabled: before?.enabled ?? true,
  ...(before?.disabledByRatings === true ? { disabledByRatings: true } : {}),
  helpful: before?.helpful ?? 0,
  unhelpful: before?.unhelpful ?? 0,
});

/**
 * The skill after a learning agent hands over what it found: its lessons replace the learned
 * ones, the user's own lessons stay, and a lesson learned again keeps whether it was on.
 */
export function mergeLearnedReviewSkill(
  previous: ReviewSkill | null,
  learned: SubmitReviewSkillInput,
  at: Pick<ReviewSkill, "projectId" | "learningThreadId"> & {
    readonly learnedAt: NonNullable<ReviewSkill["learnedAt"]>;
  },
): ReviewSkill {
  const before = new Map((previous?.lessons ?? []).map((lesson) => [lesson.id, lesson] as const));
  const yours = (previous?.lessons ?? []).filter((lesson) => lesson.source === "yours");
  const taken = new Set(yours.map((lesson) => lesson.id));
  const lessons = [...yours];
  for (const lesson of learned.lessons) {
    if (lessons.length >= REVIEW_SKILL_MAX_LESSONS) break;
    const id = reviewSkillLessonId(lesson.text);
    // The same words twice in one hand-over are one lesson.
    if (taken.has(id)) continue;
    taken.add(id);
    const earlier = before.get(id);
    lessons.push(learnedLesson(lesson, id, earlier?.source === "yours" ? undefined : earlier));
  }
  return {
    projectId: at.projectId,
    status: "learned",
    learningThreadId: at.learningThreadId,
    learnedAt: at.learnedAt,
    summary: learned.summary.trim(),
    lessons,
  };
}

/** The skill after one edit by the user, or why it cannot be made. */
export function editReviewSkill(
  skill: ReviewSkill,
  edit: ReviewSkillEdit,
): ReviewSkill | "lesson" | "full" {
  switch (edit.kind) {
    case "set-enabled": {
      if (!skill.lessons.some((lesson) => lesson.id === edit.lessonId)) return "lesson";
      return {
        ...skill,
        lessons: skill.lessons.map((lesson) => {
          if (lesson.id !== edit.lessonId) return lesson;
          // The user's own choice replaces whatever their ratings did.
          const { disabledByRatings: _, ...rest } = lesson;
          return { ...rest, enabled: edit.enabled };
        }),
      };
    }
    case "add": {
      if (skill.lessons.length >= REVIEW_SKILL_MAX_LESSONS) return "full";
      const id = reviewSkillLessonId(edit.text, new Set(skill.lessons.map((lesson) => lesson.id)));
      return {
        ...skill,
        lessons: [
          {
            id,
            text: edit.text,
            ...(edit.where === undefined ? {} : { where: edit.where }),
            source: "yours",
            evidence: [],
            enabled: true,
            helpful: 0,
            unhelpful: 0,
          } satisfies ReviewSkillLesson,
          ...skill.lessons,
        ],
      };
    }
    case "remove": {
      if (!skill.lessons.some((lesson) => lesson.id === edit.lessonId)) return "lesson";
      return { ...skill, lessons: skill.lessons.filter((lesson) => lesson.id !== edit.lessonId) };
    }
  }
}

/**
 * How findings that cited each lesson are rated now: each finding counts once, as last rated,
 * and not at all when its rating was taken back. Activities are read oldest first.
 */
export function reviewSkillRatingCounts(
  activities: ReadonlyArray<Pick<OrchestrationThreadActivity, "kind" | "payload">>,
  projectId: string,
): ReadonlyMap<string, { readonly helpful: number; readonly unhelpful: number }> {
  const latest = new Map<string, { readonly lessonId: string; readonly up: boolean } | null>();
  for (const activity of activities) {
    if (activity.kind !== REVIEW_FINDING_RATING_ACTIVITY_KIND) continue;
    const payload = Option.getOrUndefined(decodeRating(activity.payload));
    if (payload === undefined || payload.projectId !== projectId) continue;
    const lessonId = payload.finding.lessonId;
    if (lessonId === undefined) continue;
    latest.set(
      `${payload.findingsActivityId}/${payload.key}`,
      payload.rating === null ? null : { lessonId, up: payload.rating === "up" },
    );
  }
  const counts = new Map<string, { helpful: number; unhelpful: number }>();
  for (const rated of latest.values()) {
    if (rated === null) continue;
    const count = counts.get(rated.lessonId) ?? { helpful: 0, unhelpful: 0 };
    if (rated.up) count.helpful += 1;
    else count.unhelpful += 1;
    counts.set(rated.lessonId, count);
  }
  return counts;
}

/**
 * The skill with its lessons' ratings counted. A learned lesson that reaches the limit of
 * thumbs-down without one thumbs-up is switched off, once: the user can switch it back on and
 * later ratings leave their choice alone.
 */
export function applyReviewSkillRatings(
  skill: ReviewSkill,
  counts: ReadonlyMap<string, { readonly helpful: number; readonly unhelpful: number }>,
): ReviewSkill {
  return {
    ...skill,
    lessons: skill.lessons.map((lesson) => {
      const { helpful, unhelpful } = counts.get(lesson.id) ?? { helpful: 0, unhelpful: 0 };
      const reachedLimit =
        lesson.unhelpful < REVIEW_SKILL_UNHELPFUL_LIMIT &&
        unhelpful >= REVIEW_SKILL_UNHELPFUL_LIMIT &&
        helpful === 0;
      return reachedLimit && lesson.enabled && lesson.source !== "yours"
        ? { ...lesson, helpful, unhelpful, enabled: false, disabledByRatings: true }
        : { ...lesson, helpful, unhelpful };
    }),
  };
}

/** What a reviewer reads: the summary and the lessons that are on. Field names are in the playbook. */
export function reviewSkillForReviewer(skill: ReviewSkill) {
  return {
    summary: skill.summary,
    lessons: skill.lessons
      .filter((lesson) => lesson.enabled)
      .map(({ id, text, where, source, occurrences, evidence }) => ({
        id,
        text,
        ...(where === undefined ? {} : { where }),
        source,
        ...(occurrences === undefined ? {} : { occurrences }),
        ...(evidence.length === 0 ? {} : { evidence }),
      })),
  };
}
