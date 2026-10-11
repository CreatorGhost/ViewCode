import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  PullRequestUnavailableError,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type PullRequestDetail,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandInvariantError } from "../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestAgentReview from "./PullRequestAgentReview.ts";
import * as PullRequestService from "./PullRequestService.ts";

const PROJECT_ID = ProjectId.make("project-1");
const REFERENCE = { projectId: PROJECT_ID, repository: "t3tools/t3code", number: 42 };
const PROJECT_MODEL = { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" };

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:t3tools/t3code.git",
    },
    provider: "github",
    displayName: "t3tools/t3code",
    owner: "t3tools",
    name: "t3code",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const summary: PullRequestSummary = {
  provider: "github",
  projectId: PROJECT_ID,
  repository: "t3tools/t3code",
  number: 42,
  title: "Cache the probe",
  url: "https://github.com/t3tools/t3code/pull/42",
  state: "open",
  headBranch: "cache-probe",
  baseBranch: "main",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const makeHarness = (options: {
  readonly defaultModel?: typeof PROJECT_MODEL | null;
  readonly summary?: Effect.Effect<PullRequestSummary, PullRequestService.PullRequestError>;
  readonly rejectLink?: boolean;
  readonly detail?: Effect.Effect<PullRequestDetail, PullRequestService.PullRequestError>;
  readonly reviewStyles?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const detailReads = yield* Ref.make(0);
    const dependencies = Layer.mergeAll(
      Layer.mock(PullRequestService.PullRequestService)({
        summary: () => options.summary ?? Effect.succeed(summary),
        detail: () =>
          Ref.update(detailReads, (count) => count + 1).pipe(
            Effect.andThen(
              options.detail ??
                Effect.fail(new PullRequestUnavailableError({ reason: "provider-unsupported" })),
            ),
          ),
      }),
      Layer.mock(ProjectionSnapshotQuery)({
        getProjectShellById: (projectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      }),
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
        dispatch: (command) =>
          options.rejectLink === true && command.type === "thread.pull-request.link"
            ? Effect.fail(
                new OrchestrationCommandInvariantError({
                  commandType: command.type,
                  detail: "the thread is settled",
                }),
              )
            : Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
      }),
      ServerSettings.layerTest({
        defaultModelSelection: options.defaultModel === undefined ? null : options.defaultModel,
        defaultRuntimeMode: "approval-required",
        pullRequestReviewStyles: options.reviewStyles ?? {},
      }),
    ).pipe(
      Layer.provideMerge(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-pr-agent-review-" }).pipe(
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    );
    const { reviews, config } = yield* Effect.all({
      reviews: PullRequestAgentReview.PullRequestAgentReview,
      config: ServerConfig.ServerConfig,
    }).pipe(Effect.provide(PullRequestAgentReview.layer.pipe(Layer.provideMerge(dependencies))));
    return { reviews, commands, detailReads, stateDir: config.stateDir };
  });

describe("PullRequestAgentReview", () => {
  it.effect("creates a linked thread in the project and asks for the review by playbook", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        detail: Effect.succeed({ headSha: "0a1b2c3d4e" } as PullRequestDetail),
      });
      const result = yield* harness.reviews.start({
        reference: REFERENCE,
        mode: "security",
        focus: "token handling",
        linkSource: "manual",
      });
      expect(result.title).toBe("Security audit: #42 Cache the probe");

      const [create, link, started, turn] = yield* Ref.get(harness.commands);
      expect(create).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        projectId: PROJECT_ID,
        title: "Security audit: #42 Cache the probe",
        modelSelection: PROJECT_MODEL,
        // The user's default for new threads, never a silent full access.
        runtimeMode: "approval-required",
        branch: null,
        worktreePath: null,
      });
      expect(link).toMatchObject({
        type: "thread.pull-request.link",
        threadId: result.threadId,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        url: summary.url,
        source: "manual",
      });
      // The commit under review is recorded outside any turn, for the findings to be pinned to.
      expect(started).toMatchObject({
        type: "thread.activity.append",
        threadId: result.threadId,
        activity: {
          kind: "viewcode.review.started",
          payload: { headSha: "0a1b2c3d4e", timelineBypass: true },
          turnId: null,
        },
      });
      expect(turn?.type).toBe("thread.turn.start");
      const text = turn?.type === "thread.turn.start" ? turn.message.text : "";
      const playbookPath = `${harness.stateDir}/review-playbooks/security-audit.md`;
      expect(text).toContain("Security audit of pull request #42: Cache the probe");
      expect(text).toContain(summary.url);
      expect(text).toContain("cache-probe into main");
      expect(text).toContain(playbookPath);
      expect(text).toContain("Focus on: token handling");
      expect(text).toContain("Review head commit 0a1b2c3d4e.");

      // The path in the message is a real file holding that mode's method.
      const fs = yield* FileSystem.FileSystem;
      const playbook = yield* fs.readFileString(playbookPath);
      expect(playbook).toContain("# ViewCode Security audit");
      expect(playbook).toContain("Never modify the user's working tree");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("defaults to a quick review on the fallback model when no default is set", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const fallback = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
      const result = yield* harness.reviews.start({
        reference: REFERENCE,
        fallbackModelSelection: fallback,
        linkSource: "agent",
      });
      expect(result.title).toBe("Review: #42 Cache the probe");
      const [create, , , turn] = yield* Ref.get(harness.commands);
      expect(create).toMatchObject({ modelSelection: fallback });
      expect(turn?.type === "thread.turn.start" ? turn.message.text : "").toContain(
        `${harness.stateDir}/review-playbooks/quick-review.md`,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("asks the reviewer to pass the findings mode the user chose", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      yield* harness.reviews.start({
        reference: REFERENCE,
        findingsMode: "comment",
        linkSource: "manual",
      });
      const turn = (yield* Ref.get(harness.commands)).at(-1);
      expect(turn?.type === "thread.turn.start" ? turn.message.text : "").toContain(
        'When you call submit_review_findings, pass mode "comment".',
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("asks for review comments in the user's style on somebody else's pull request", () =>
    Effect.gen(function* () {
      const detail = (author: string) =>
        Effect.succeed({
          author: { login: author, name: null, avatarUrl: null },
          viewer: "Bilal",
        } as PullRequestDetail);
      const reviewStyles = { "github.com/bilal": "Lowercase, no pleasantries, ask questions." };
      const lastMessage = (commands: ReadonlyArray<OrchestrationCommand>) => {
        const turn = commands.at(-1);
        return turn?.type === "thread.turn.start" ? turn.message.text : "";
      };

      const theirs = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        detail: detail("octocat"),
        reviewStyles,
      });
      yield* theirs.reviews.start({ reference: REFERENCE, linkSource: "manual" });
      const text = lastMessage(yield* Ref.get(theirs.commands));
      expect(text).toContain("as my review comments");
      expect(text).toContain("Write them in my review style:\n\nLowercase, no pleasantries");
      expect(text).not.toContain("pass mode");
      expect(text).not.toContain("past review comments");

      // Once something was learned for the account, the reviewer is pointed at it, and the
      // playbook says how to use it.
      const fs = yield* FileSystem.FileSystem;
      const samplesPath = `${theirs.stateDir}/review-style/github.com/bilal.json`;
      yield* fs.makeDirectory(`${theirs.stateDir}/review-style/github.com`, { recursive: true });
      yield* fs.writeFileString(
        samplesPath,
        `{"host":"github.com","login":"Bilal","fetchedAt":"2026-09-01T00:00:00.000Z","samples":[{"kind":"inline","state":"commented","text":"why a Map?"}]}`,
      );
      yield* theirs.reviews.start({ reference: REFERENCE, linkSource: "manual" });
      const learned = lastMessage(yield* Ref.get(theirs.commands));
      expect(learned).toContain(`my past review comments are in ${samplesPath}`);
      expect(learned).toContain("Write them in my review style:");
      const playbook = yield* fs.readFileString(
        `${theirs.stateDir}/review-playbooks/quick-review.md`,
      );
      expect(playbook).toContain("Imitate the writing, never\nthe content");
      expect(playbook).toContain("the style wins");

      const mine = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        detail: detail("bilal"),
        reviewStyles,
      });
      yield* mine.reviews.start({ reference: REFERENCE, linkSource: "manual" });
      expect(lastMessage(yield* Ref.get(mine.commands))).not.toContain("review comments");

      // Fixing was asked for: whose pull request it is does not matter.
      const fixing = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        detail: detail("octocat"),
        reviewStyles,
      });
      yield* fixing.reviews.start({
        reference: REFERENCE,
        findingsMode: "fix",
        linkSource: "manual",
      });
      expect(lastMessage(yield* Ref.get(fixing.commands))).not.toContain("review comments");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reads who opened the pull request, and nobody when the host cannot say", () =>
    Effect.gen(function* () {
      const read = yield* makeHarness({
        detail: Effect.succeed({
          author: { login: "octocat", name: null, avatarUrl: null },
          viewer: "bilal",
        } as PullRequestDetail),
      });
      expect(yield* read.reviews.authorship(REFERENCE)).toEqual({
        author: "octocat",
        viewer: "bilal",
      });
      const unreadable = yield* makeHarness({});
      expect(yield* unreadable.reviews.authorship(REFERENCE)).toEqual({
        author: null,
        viewer: null,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses before creating anything when no model can be chosen", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const error = yield* harness.reviews
        .start({ reference: REFERENCE, linkSource: "manual" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestAgentReviewError", stage: "model" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("passes a host failure through untouched and creates nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        summary: Effect.fail(
          new PullRequestUnavailableError({ reason: "cli-unauthenticated", provider: "github" }),
        ),
      });
      const error = yield* harness.reviews
        .start({ reference: REFERENCE, linkSource: "manual" })
        .pipe(Effect.flip);
      expect(error._tag).toBe("PullRequestUnavailableError");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("names the step that failed once the thread exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL, rejectLink: true });
      const error = yield* harness.reviews
        .start({ reference: REFERENCE, linkSource: "manual" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestAgentReviewError", stage: "link" });
      expect(error.message).toContain("could not be linked");
      expect((yield* Ref.get(harness.commands)).map((command) => command.type)).toEqual([
        "thread.create",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("reviewFindingsModeFor", () => {
  it("comments on somebody else's pull request and fixes the reader's own", () => {
    expect(
      PullRequestAgentReview.reviewFindingsModeFor({ author: "octocat", viewer: "bilal" }),
    ).toBe("comment");
    expect(PullRequestAgentReview.reviewFindingsModeFor({ author: "Bilal", viewer: "bilal" })).toBe(
      "fix",
    );
  });

  it("fixes when either name is unknown, since fixing posts nothing", () => {
    expect(PullRequestAgentReview.reviewFindingsModeFor({ author: null, viewer: "bilal" })).toBe(
      "fix",
    );
    expect(PullRequestAgentReview.reviewFindingsModeFor({ author: "octocat", viewer: null })).toBe(
      "fix",
    );
  });
});
