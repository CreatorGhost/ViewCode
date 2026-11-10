import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import {
  ProjectId,
  ThreadId,
  type ModelSelection,
  type SubmitReviewSkillInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectReviewSkill from "./ProjectReviewSkill.ts";
import { ReviewActivityStoreV2 } from "./ReviewActivityStoreV2.ts";

const PROJECT_ID = ProjectId.make("project-1");
const MODEL = { instanceId: "claude", model: "claude-test" } as unknown as ModelSelection;
const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const learned = {
  summary: "Reviewers here ask for reversible migrations.",
  lessons: [{ text: "NOT NULL columns need a backfill", source: "kept-breaking", occurrences: 4 }],
} as unknown as SubmitReviewSkillInput;

const makeHarness = (
  options: {
    readonly repository?: boolean;
    readonly autoLearn?: boolean;
    readonly defaultModel?: ModelSelection | null;
  } = {},
) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<
      ReadonlyArray<{ readonly type: string; readonly threadId: ThreadId }>
    >([]);
    const record = (command: { readonly type: string; readonly threadId: ThreadId }) =>
      Ref.update(commands, (all) => [...all, command]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ThreadManagementService)({
        dispatch: (command) =>
          record({
            type: command.type,
            threadId: (command as { readonly threadId: ThreadId }).threadId,
          }).pipe(Effect.as({} as never)),
        sendToThread: (input) =>
          record({ type: "message", threadId: input.threadId }).pipe(Effect.as({} as never)),
      }),
      Layer.mock(ProjectStoreV2)({
        getShell: (projectId) =>
          Effect.succeed(
            projectId === PROJECT_ID
              ? Option.some({
                  id: PROJECT_ID,
                  title: "agents",
                  workspaceRoot: "/repo",
                  repositoryIdentity: options.repository === false ? null : { canonicalKey: "k" },
                } as never)
              : Option.none(),
          ),
      }),
      Layer.mock(ReviewActivityStoreV2)({ listByKind: () => Effect.succeed([]) }),
      ServerSettings.layerTest({
        defaultModelSelection: options.defaultModel === undefined ? MODEL : options.defaultModel,
        defaultRuntimeMode: "approval-required",
        reviewSkillAutoLearn: options.autoLearn ?? true,
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-review-skill-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    const { skills, config } = yield* Effect.all({
      skills: ProjectReviewSkill.ProjectReviewSkill,
      config: ServerConfig.ServerConfig,
    }).pipe(Effect.provide(ProjectReviewSkill.layer.pipe(Layer.provideMerge(dependencies))));
    return { skills, commands, stateDir: config.stateDir };
  });

describe("ProjectReviewSkill", () => {
  it.effect(
    "learns a project once on its own, in a thread only that thread may hand over from",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.skills.get(PROJECT_ID)).toBeNull();

        const learning = yield* harness.skills.learn({ projectId: PROJECT_ID, auto: true });
        expect(learning).toMatchObject({ status: "learning", lessons: [] });
        const started = yield* Ref.get(harness.commands);
        expect(started.map((command) => command.type)).toEqual(["thread.create", "message"]);
        const threadId = started[0]!.threadId;
        expect(learning?.learningThreadId).toBe(threadId);

        // A second client opening the project starts nothing.
        yield* harness.skills.learn({ projectId: PROJECT_ID, auto: true });
        expect(yield* Ref.get(harness.commands)).toHaveLength(2);

        const stranger = yield* harness.skills
          .submit({ projectId: PROJECT_ID, threadId: ThreadId.make("other"), learned })
          .pipe(Effect.flip);
        expect(stranger.stage).toBe("not-learning");

        const skill = yield* harness.skills.submit({ projectId: PROJECT_ID, threadId, learned });
        expect(skill).toMatchObject({
          status: "learned",
          lessons: [{ id: "not-null-columns-need-a-backfill", enabled: true, occurrences: 4 }],
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "does not learn on its own when turned off, without a repository or without a model",
    () =>
      Effect.gen(function* () {
        for (const options of [
          { autoLearn: false },
          { repository: false },
          { defaultModel: null },
        ] as const) {
          const harness = yield* makeHarness(options);
          expect(yield* harness.skills.learn({ projectId: PROJECT_ID, auto: true })).toBeNull();
          expect(yield* Ref.get(harness.commands)).toEqual([]);
        }
        // Asked for by the user, a project without a repository is still learned.
        const asked = yield* makeHarness({ repository: false, autoLearn: false });
        expect(yield* asked.skills.learn({ projectId: PROJECT_ID })).toMatchObject({
          status: "learning",
        });
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("hands a reviewer only the lessons that are on, and nothing once forgotten", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const fs = yield* FileSystem.FileSystem;
      expect(yield* harness.skills.writeReviewerFile(PROJECT_ID)).toBeNull();

      yield* harness.skills.learn({ projectId: PROJECT_ID });
      const threadId = (yield* Ref.get(harness.commands))[0]!.threadId;
      yield* harness.skills.submit({ projectId: PROJECT_ID, threadId, learned });
      yield* harness.skills.edit({
        projectId: PROJECT_ID,
        edit: { kind: "add", text: "Never log tokens" as never },
      });
      yield* harness.skills.edit({
        projectId: PROJECT_ID,
        edit: {
          kind: "set-enabled",
          lessonId: "not-null-columns-need-a-backfill" as never,
          enabled: false,
        },
      });

      const file = yield* harness.skills.writeReviewerFile(PROJECT_ID);
      expect(file).not.toBeNull();
      expect(decodeJson(yield* fs.readFileString(file!))).toMatchObject({
        summary: "Reviewers here ask for reversible migrations.",
        lessons: [{ id: "never-log-tokens", source: "yours" }],
      });

      const missing = yield* harness.skills
        .edit({ projectId: PROJECT_ID, edit: { kind: "remove", lessonId: "nope" as never } })
        .pipe(Effect.flip);
      expect(missing.stage).toBe("lesson");

      yield* harness.skills.forget(PROJECT_ID);
      expect(yield* harness.skills.get(PROJECT_ID)).toBeNull();
      expect(yield* harness.skills.writeReviewerFile(PROJECT_ID)).toBeNull();
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
