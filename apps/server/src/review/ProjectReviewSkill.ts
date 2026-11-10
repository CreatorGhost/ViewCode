/**
 * A project's review skill: what its history teaches a reviewer. An agent learns it in a thread
 * of the project (see the learning playbook in `ReviewPlaybook.ts`) and hands it over with
 * `submit_review_skill`; the user switches lessons off, adds their own and rates the findings
 * that cite them; every review of the project is told where the skill is.
 *
 * One JSON file per project in the state directory, so the skill is this user's and not the
 * repository's. The rules of merging, editing and rating are in `@t3tools/shared/reviewSkill`.
 */
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
  REVIEW_FINDING_RATING_ACTIVITY_KIND,
  ReviewSkill,
  ReviewSkillError,
  ThreadId,
  type ModelSelection,
  type ProjectId,
  type ReviewEditSkillInput,
  type ReviewLearnSkillInput,
  type RuntimeMode,
  type SubmitReviewSkillInput,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  applyReviewSkillRatings,
  editReviewSkill,
  mergeLearnedReviewSkill,
  reviewSkillForReviewer,
  reviewSkillRatingCounts,
} from "@t3tools/shared/reviewSkill";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ReviewActivityStore from "./ReviewActivityStoreV2.ts";
import { ensureReviewSkillPlaybook, SUBMIT_REVIEW_SKILL_TOOL } from "./ReviewPlaybook.ts";

const SKILL_DIR = "review-skills";
/** What a reviewer reads, beside the skill itself. */
const REVIEWER_FILE_SUFFIX = ".reviewer.json";

const decodeSkill = Schema.decodeUnknownOption(Schema.fromJsonString(ReviewSkill));
const encodeSkill = Schema.encodeSync(Schema.fromJsonString(ReviewSkill));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export class ProjectReviewSkill extends Context.Service<
  ProjectReviewSkill,
  {
    /** The project's skill with its lessons' ratings counted, or null before it was learned. */
    readonly get: (projectId: ProjectId) => Effect.Effect<ReviewSkill | null, ReviewSkillError>;
    /**
     * Starts an agent that learns the skill. Asked for with `auto`, it starts only for a project
     * with a repository, never learned and not being learned, while the setting allows it, and
     * otherwise returns what there is.
     */
    readonly learn: (
      input: ReviewLearnSkillInput & {
        readonly fallbackModelSelection?: ModelSelection | undefined;
      },
    ) => Effect.Effect<ReviewSkill | null, ReviewSkillError>;
    readonly edit: (input: ReviewEditSkillInput) => Effect.Effect<ReviewSkill, ReviewSkillError>;
    readonly forget: (projectId: ProjectId) => Effect.Effect<void, ReviewSkillError>;
    /** What the learning agent in `threadId` found, merged into what the user has. */
    readonly submit: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly learned: SubmitReviewSkillInput;
    }) => Effect.Effect<ReviewSkill, ReviewSkillError>;
    /** Counts a new rating in, which can switch a lesson off. Never fails: the rating stands. */
    readonly ratingsChanged: (projectId: ProjectId) => Effect.Effect<void>;
    /**
     * Writes the lessons that are on for a reviewer to read and returns the file, or null when
     * there is nothing to tell one. Never fails: a review starts without the skill.
     */
    readonly writeReviewerFile: (projectId: ProjectId) => Effect.Effect<string | null>;
  }
>()("t3/review/ProjectReviewSkill") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const activities = yield* ReviewActivityStore.ReviewActivityStoreV2;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);
  // One writer at a time: two clients opening a project must not both start learning it, and an
  // edit must not be lost under a rating.
  const lock = yield* Semaphore.make(1);

  const failure =
    (stage: ReviewSkillError["stage"]) =>
    (cause: unknown): ReviewSkillError =>
      new ReviewSkillError({ stage, cause });
  const dir = path.join(config.stateDir, SKILL_DIR);
  const fileOf = (projectId: ProjectId) => path.join(dir, `${encodeURIComponent(projectId)}.json`);

  const read = (projectId: ProjectId) =>
    Effect.gen(function* () {
      const target = fileOf(projectId);
      if (!(yield* fileSystem.exists(target))) return null;
      return Option.getOrNull(decodeSkill(yield* fileSystem.readFileString(target)));
    }).pipe(Effect.mapError(failure("read")));

  const writeFile = (target: string, content: string) =>
    Effect.gen(function* () {
      // Reviews and clients read while this writes; a rename keeps every reader's file whole.
      const temporary = `${target}.${yield* uuid}.tmp`;
      yield* fileSystem.makeDirectory(dir, { recursive: true });
      yield* fileSystem.writeFileString(temporary, content);
      yield* fileSystem.rename(temporary, target);
    });
  const write = (skill: ReviewSkill) =>
    writeFile(fileOf(skill.projectId), encodeSkill(skill)).pipe(Effect.mapError(failure("write")));

  const counted = (skill: ReviewSkill) =>
    activities.listByKind(REVIEW_FINDING_RATING_ACTIVITY_KIND).pipe(
      Effect.map((records) =>
        applyReviewSkillRatings(skill, reviewSkillRatingCounts(records, skill.projectId)),
      ),
      // The lessons matter more than their counts.
      Effect.orElseSucceed(() => skill),
    );

  const get: ProjectReviewSkill["Service"]["get"] = Effect.fn("ProjectReviewSkill.get")(
    function* (projectId) {
      const skill = yield* read(projectId);
      return skill === null ? null : yield* counted(skill);
    },
  );

  const startLearning = Effect.fn("ProjectReviewSkill.startLearning")(function* (input: {
    readonly projectId: ProjectId;
    readonly title: string;
    readonly modelSelection: ModelSelection;
    readonly runtimeMode: RuntimeMode;
  }) {
    const playbookPath = yield* ensureReviewSkillPlaybook({ stateDir: config.stateDir }).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );
    const threadId = ThreadId.make(yield* uuid);
    yield* threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`server:review-skill:${threadId}`),
      threadId,
      projectId: input.projectId,
      title: input.title,
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      // The repository's own checkout; the agent only reads it.
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "server",
    });
    yield* threads.sendToThread({
      commandId: CommandId.make(`server:review-skill-turn:${threadId}`),
      projectId: input.projectId,
      threadId,
      messageId: MessageId.make(yield* uuid),
      text: [
        "Learn how this project is reviewed, so later reviews of it know what to look for.",
        "",
        `Read the playbook at ${playbookPath} and follow it. Change nothing in my working tree, post nothing to the host, and hand over what you learn with ${SUBMIT_REVIEW_SKILL_TOOL}.`,
      ].join("\n"),
      attachments: [],
      modelSelection: input.modelSelection,
      mode: "auto",
      createdBy: "user",
      creationSource: "server",
    });
    return threadId;
  });

  const learn: ProjectReviewSkill["Service"]["learn"] = (input) =>
    Effect.gen(function* () {
      const existing = yield* read(input.projectId);
      const auto = input.auto === true;
      if (auto && existing !== null) return yield* counted(existing);
      const project = yield* projects
        .getShell(input.projectId)
        .pipe(Effect.mapError(failure("project")));
      if (Option.isNone(project)) return yield* new ReviewSkillError({ stage: "project" });
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(failure("project")));
      // History to learn from is on the host; a folder with no repository has none worth an agent.
      if (auto && (!settings.reviewSkillAutoLearn || project.value.repositoryIdentity == null)) {
        return null;
      }
      const defaults = resolveProjectSettings(settings, input.projectId, project.value).settings;
      const modelSelection =
        input.modelSelection ?? defaults.defaultModelSelection ?? input.fallbackModelSelection;
      if (modelSelection === undefined) {
        return auto ? null : yield* new ReviewSkillError({ stage: "model" });
      }
      const threadId = yield* startLearning({
        projectId: input.projectId,
        title: `Learn: how ${project.value.title} is reviewed`,
        modelSelection,
        runtimeMode: defaults.defaultRuntimeMode,
      }).pipe(Effect.mapError(failure("start")));
      const learning: ReviewSkill = {
        projectId: input.projectId,
        status: "learning",
        learningThreadId: threadId,
        learnedAt: existing?.learnedAt ?? null,
        summary: existing?.summary ?? "",
        lessons: existing?.lessons ?? [],
      };
      yield* write(learning);
      return yield* counted(learning);
    }).pipe(lock.withPermits(1), Effect.withSpan("ProjectReviewSkill.learn"));

  const edit: ProjectReviewSkill["Service"]["edit"] = (input) =>
    Effect.gen(function* () {
      // A lesson of the user's own can be added before anything was learned.
      const skill: ReviewSkill = (yield* read(input.projectId)) ?? {
        projectId: input.projectId,
        status: "learned",
        learningThreadId: null,
        learnedAt: null,
        summary: "",
        lessons: [],
      };
      const next = editReviewSkill(skill, input.edit);
      if (typeof next === "string") return yield* new ReviewSkillError({ stage: next });
      yield* write(next);
      return yield* counted(next);
    }).pipe(lock.withPermits(1), Effect.withSpan("ProjectReviewSkill.edit"));

  const forget: ProjectReviewSkill["Service"]["forget"] = (projectId) =>
    Effect.gen(function* () {
      yield* fileSystem.remove(fileOf(projectId), { force: true });
      yield* fileSystem.remove(`${fileOf(projectId)}${REVIEWER_FILE_SUFFIX}`, { force: true });
    }).pipe(
      Effect.mapError(failure("write")),
      lock.withPermits(1),
      Effect.withSpan("ProjectReviewSkill.forget"),
    );

  const submit: ProjectReviewSkill["Service"]["submit"] = (input) =>
    Effect.gen(function* () {
      const previous = yield* read(input.projectId);
      // Every later review trusts the skill, so only the thread asked to learn it may write it.
      if (previous?.learningThreadId !== input.threadId) {
        return yield* new ReviewSkillError({ stage: "not-learning" });
      }
      const learnedAt = DateTime.formatIso(yield* DateTime.now);
      const next = mergeLearnedReviewSkill(previous, input.learned, {
        projectId: input.projectId,
        learningThreadId: input.threadId,
        learnedAt: learnedAt as NonNullable<ReviewSkill["learnedAt"]>,
      });
      yield* write(next);
      return yield* counted(next);
    }).pipe(lock.withPermits(1), Effect.withSpan("ProjectReviewSkill.submit"));

  const ratingsChanged: ProjectReviewSkill["Service"]["ratingsChanged"] = (projectId) =>
    Effect.gen(function* () {
      const skill = yield* read(projectId);
      if (skill === null) return;
      const next = yield* counted(skill);
      // Only a lesson switching off is worth a write; counts are recounted on every read.
      if (next.lessons.some((lesson, index) => lesson.enabled !== skill.lessons[index]?.enabled)) {
        yield* write(next);
      }
    }).pipe(
      lock.withPermits(1),
      Effect.catch((error) =>
        Effect.logWarning("Could not count a rating into the project's review skill", {
          detail: error.message,
        }),
      ),
    );

  const writeReviewerFile: ProjectReviewSkill["Service"]["writeReviewerFile"] = (projectId) =>
    Effect.gen(function* () {
      const skill = yield* read(projectId);
      if (skill === null) return null;
      const forReviewer = reviewSkillForReviewer(skill);
      if (forReviewer.lessons.length === 0 && forReviewer.summary.length === 0) return null;
      const target = `${fileOf(projectId)}${REVIEWER_FILE_SUFFIX}`;
      yield* writeFile(target, encodeJson(forReviewer));
      return target;
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not hand the project's review skill to the review", {
          detail: error.message,
        }).pipe(Effect.as(null)),
      ),
    );

  return ProjectReviewSkill.of({
    get,
    learn,
    edit,
    forget,
    submit,
    ratingsChanged,
    writeReviewerFile,
  });
});

export const layer = Layer.effect(ProjectReviewSkill, make);
