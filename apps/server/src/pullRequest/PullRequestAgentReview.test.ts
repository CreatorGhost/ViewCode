import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  SourceControlProviderKind,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  PullRequestUnavailableError,
  type OrchestrationV2ServerCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationV2ThreadShell,
  type PullRequestDetail,
  type PullRequestSummary,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as ServerConfig from "../config.ts";
import { OrchestratorDispatchError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ReviewActivityStoreV2 } from "../review/ReviewActivityStoreV2.ts";
import * as ReviewFindingRatings from "../review/ReviewFindingRatings.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PullRequestAgentReview from "./PullRequestAgentReview.ts";
import * as PullRequestService from "./PullRequestService.ts";

type ReviewRecord =
  | OrchestrationV2ServerCommand
  | ({ readonly type: "review.activity.record" } & Parameters<
      ReviewActivityStoreV2["Service"]["append"]
    >[0]);

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const PROJECT_ID = ProjectId.make("project-1");
const REFERENCE = { projectId: PROJECT_ID, repository: "t3tools/t3code", number: 42 };
const PROJECT_MODEL = { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" };

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  repositoryIdentity: {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:t3tools/t3code.git",
    },
    provider: SourceControlProviderKind.make("github"),
    displayName: "t3tools/t3code",
    owner: "t3tools",
    name: "t3code",
  },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const summary: PullRequestSummary = {
  provider: SourceControlProviderKind.make("github"),
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

const SOURCE_THREADS: Record<string, OrchestrationV2ThreadShell> = {
  "source-thread": {
    id: ThreadId.make("source-thread"),
    projectId: PROJECT_ID,
    branch: "feature/cache",
    worktreePath: "/worktrees/project/cache",
  } as OrchestrationV2ThreadShell,
  "elsewhere-thread": {
    id: ThreadId.make("elsewhere-thread"),
    projectId: ProjectId.make("project-2"),
    branch: "main",
    worktreePath: null,
  } as OrchestrationV2ThreadShell,
};

const EARLIER_REVIEW_THREAD = ThreadId.make("earlier-review");

const earlierFindings = (
  id: string,
  target: object,
  headSha?: string,
): OrchestrationThreadActivity => ({
  id: EventId.make(id),
  tone: "info",
  kind: "viewcode.review.findings",
  summary: "Review: request changes, 1 finding",
  payload: {
    verdict: "request-changes",
    mergeConfidence: 2,
    reviewEffort: 2,
    findings: [
      {
        severity: "blocker",
        confidence: 90,
        path: "src/a.ts",
        line: 3,
        title: "Unchecked input",
        detail: "It reaches the shell.",
      },
    ],
    needsChecking: [],
    target,
    ...(headSha === undefined ? {} : { headSha }),
  },
  turnId: null,
  createdAt: "2026-08-20T00:00:00.000Z",
});

const PR_TARGET = {
  kind: "pull-request",
  host: "github.com",
  repository: "t3tools/t3code",
  number: 42,
  url: "https://github.com/t3tools/t3code/pull/42",
};

const makeHarness = (options: {
  readonly defaultModel?: typeof PROJECT_MODEL | null;
  readonly summary?: Effect.Effect<PullRequestSummary, PullRequestService.PullRequestError>;
  readonly rejectLink?: boolean;
  readonly detail?: Effect.Effect<PullRequestDetail, PullRequestService.PullRequestError>;
  readonly reviewStyles?: Record<string, string>;
  /** Findings activities on the earlier review thread. */
  readonly earlierFindings?: ReadonlyArray<OrchestrationThreadActivity>;
  readonly ratedFindingsPath?: string;
}) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<ReviewRecord>>([]);
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
      Layer.mock(ProjectStoreV2)({
        getShell: (projectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      }),
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === EARLIER_REVIEW_THREAD
              ? ({ id: threadId, projectId: PROJECT_ID } as OrchestrationV2ThreadShell)
              : (SOURCE_THREADS[threadId] ?? null),
          ),
      }),
      Layer.mock(ReviewActivityStoreV2)({
        list: () => Effect.succeed(options.earlierFindings ?? []),
        append: (command) =>
          Ref.update(commands, (all) => [
            ...all,
            { type: "review.activity.record" as const, ...command },
          ]),
      }),
      Layer.mock(ThreadManagementService)({
        dispatch: (command) =>
          options.rejectLink === true && command.type === "thread.pull-request.link"
            ? Effect.fail(
                new OrchestratorDispatchError({
                  commandId: command.commandId,
                  commandType: command.type,
                  cause: "the thread is settled",
                }),
              )
            : Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({} as never)),
        sendToThread: (input) =>
          Ref.update(commands, (all) => [
            ...all,
            {
              ...input,
              type: "message.dispatch" as const,
              dispatchMode: { type: "queue_after_active" as const },
            },
          ]).pipe(Effect.as({} as never)),
      }),
      Layer.mock(ReviewFindingRatings.ReviewFindingRatings)({
        writeRatedFindingsFile: () => Effect.succeed(options.ratedFindingsPath ?? null),
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
      // Started from the pull request page, which is no chat: a thread of its own.
      expect(create).not.toHaveProperty("parentThreadId");
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
        type: "review.activity.record",
        threadId: result.threadId,
        activity: {
          kind: "viewcode.review.started",
          // What was asked for, for clients to recognise the review and start it again.
          payload: {
            mode: "security",
            focus: "token handling",
            headSha: "0a1b2c3d4e",
            timelineBypass: true,
          },
          turnId: null,
        },
      });
      expect(turn?.type).toBe("message.dispatch");
      const text = turn?.type === "message.dispatch" ? turn.text : "";
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

  it.effect("runs a review asked for from a chat as that chat's child agent", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      const source = ThreadId.make("source-thread");
      const result = yield* harness.reviews.start({
        reference: REFERENCE,
        mode: "deep",
        linkSource: "manual",
        sourceThreadId: source,
      });
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "thread.pull-request.link",
        "review.activity.record",
        "message.dispatch",
        "review.activity.record",
      ]);
      expect(commands[0]).toMatchObject({ threadId: result.threadId, parentThreadId: source });
      const turn = commands[3];
      // The chat shows the reviewer as an agent it started, and is sent nothing back.
      expect(commands[4]).toMatchObject({
        threadId: source,
        activity: {
          kind: "viewcode.agent-message.sent",
          turnId: null,
          payload: {
            messageId: turn?.type === "message.dispatch" ? turn.messageId : "",
            toThreadId: result.threadId,
            toName: "Deep review: #42 Cache the probe",
            kind: "spawn",
            review: "deep",
            replyExpected: false,
          },
        },
      });

      const elsewhere = yield* harness.reviews
        .start({
          reference: REFERENCE,
          linkSource: "manual",
          sourceThreadId: ThreadId.make("elsewhere-thread"),
        })
        .pipe(Effect.flip);
      expect(elsewhere).toMatchObject({ stage: "source-thread" });
      expect(yield* Ref.get(harness.commands)).toHaveLength(commands.length);
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
      expect(turn?.type === "message.dispatch" ? turn.text : "").toContain(
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
      expect(turn?.type === "message.dispatch" ? turn.text : "").toContain(
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
      const lastMessage = (commands: ReadonlyArray<ReviewRecord>) => {
        const turn = commands.at(-1);
        return turn?.type === "message.dispatch" ? turn.text : "";
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
          new PullRequestUnavailableError({
            reason: "cli-unauthenticated",
            provider: SourceControlProviderKind.make("github"),
          }),
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

describe("rated findings", () => {
  it.effect("points every review of the project at the findings the user rated", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        ratedFindingsPath: "/state/review-ratings/project-1.json",
      });
      yield* harness.reviews.start({ reference: REFERENCE, linkSource: "manual" });
      yield* harness.reviews.startLocal({ projectId: PROJECT_ID });
      const texts = (yield* Ref.get(harness.commands)).flatMap((command) =>
        command.type === "message.dispatch" ? [command.text] : [],
      );
      expect(texts).toHaveLength(2);
      for (const text of texts) {
        expect(text).toContain(
          "How I rated findings of earlier reviews in this project is in /state/review-ratings/project-1.json",
        );
      }
      const playbook = yield* (yield* FileSystem.FileSystem).readFileString(
        `${harness.stateDir}/review-playbooks/quick-review.md`,
      );
      expect(playbook).toContain("Findings like\nthe ones rated down");

      const unrated = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      yield* unrated.reviews.start({ reference: REFERENCE, linkSource: "manual" });
      const turn = (yield* Ref.get(unrated.commands)).at(-1);
      expect(turn?.type === "message.dispatch" ? turn.text : "").not.toContain("rated");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("re-reviews", () => {
  const turnText = (commands: ReadonlyArray<ReviewRecord>) => {
    const turn = commands.find((command) => command.type === "message.dispatch");
    return turn?.type === "message.dispatch" ? turn.text : "";
  };

  it.effect("includes removed changes and excludes unchanged content after a force-push", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-re-review-diff-" });
      const git = (...args: string[]) =>
        spawner
          .string(
            ChildProcess.make(
              "git",
              [
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.test",
                "-c",
                "commit.gpgSign=false",
                "-c",
                "core.hooksPath=/dev/null",
                ...args,
              ],
              { cwd },
            ),
          )
          .pipe(Effect.map((output) => output.trim()));

      yield* git("init", "--quiet");
      yield* fs.writeFileString(`${cwd}/guard.ts`, "export const guarded = false;\n");
      yield* git("add", ".");
      yield* git("commit", "--quiet", "-m", "base");
      const base = yield* git("rev-parse", "HEAD");

      yield* fs.writeFileString(`${cwd}/guard.ts`, "export const guarded = true;\n");
      yield* fs.writeFileString(`${cwd}/unchanged.ts`, "export const feature = true;\n");
      yield* git("add", ".");
      yield* git("commit", "--quiet", "-m", "reviewed changes");
      const previousHeadSha = yield* git("rev-parse", "HEAD");

      yield* git("checkout", "--quiet", "-b", "rewritten", base);
      yield* fs.writeFileString(`${cwd}/unchanged.ts`, "export const feature = true;\n");
      yield* fs.writeFileString(`${cwd}/new.ts`, "export const added = true;\n");
      yield* git("add", ".");
      yield* git("commit", "--quiet", "-m", "rewritten changes without guard");
      const headSha = yield* git("rev-parse", "HEAD");

      const prompt = PullRequestAgentReview.reReviewLines({
        previousPath: "/previous.json",
        previousHeadSha,
        headSha,
      }).join("\n");
      const diffArgs = prompt.match(/`git diff ([^`]+)`/)?.[1];
      expect(diffArgs).toBeDefined();
      const diff = yield* git("diff", ...(diffArgs ?? "").split(" "));
      expect(diff).toContain("-export const guarded = true;");
      expect(diff).toContain("+export const guarded = false;");
      expect(diff).toContain("+export const added = true;");
      expect(diff).not.toContain("unchanged.ts");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reviews only what changed since the earlier review and hands over its findings", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        detail: Effect.succeed({ headSha: "bbbbbbb" } as PullRequestDetail),
        earlierFindings: [earlierFindings("earlier", PR_TARGET, "aaaaaaa")],
      });
      yield* harness.reviews.start({
        reference: REFERENCE,
        incremental: true,
        basedOn: { threadId: EARLIER_REVIEW_THREAD, activityId: EventId.make("earlier") },
        linkSource: "manual",
      });
      const commands = yield* Ref.get(harness.commands);
      expect(commands.find((command) => command.type === "review.activity.record")).toMatchObject({
        activity: {
          payload: {
            headSha: "bbbbbbb",
            incremental: true,
            basedOn: { activityId: "earlier", headSha: "aaaaaaa" },
          },
        },
      });
      const previousPath = `${harness.stateDir}/review-previous/earlier.json`;
      const text = turnText(commands);
      expect(text).toContain(`previous review's findings are in ${previousPath}`);
      expect(text).toContain("`git diff aaaaaaa bbbbbbb`");
      expect(text).toContain("pass previous with how many were fixed");

      const fs = yield* FileSystem.FileSystem;
      expect(decodeJson(yield* fs.readFileString(previousPath))).toMatchObject({
        reviewedCommit: "aaaaaaa",
        findings: [{ key: "finding:0", title: "Unchecked input" }],
        needsChecking: [],
      });
      const playbook = yield* fs.readFileString(
        `${harness.stateDir}/review-playbooks/quick-review.md`,
      );
      expect(playbook).toContain("## Re-review");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("re-reads the whole change when the earlier review named no commit", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        detail: Effect.succeed({ headSha: "bbbbbbb" } as PullRequestDetail),
        earlierFindings: [earlierFindings("earlier", PR_TARGET)],
      });
      yield* harness.reviews.start({
        reference: REFERENCE,
        incremental: true,
        basedOn: { threadId: EARLIER_REVIEW_THREAD, activityId: EventId.make("earlier") },
        linkSource: "manual",
      });
      const text = turnText(yield* Ref.get(harness.commands));
      expect(text).toContain("Review the whole change again.");
      expect(text).not.toContain("git diff aaaaaaa");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses findings about something else and creates nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        defaultModel: PROJECT_MODEL,
        earlierFindings: [
          earlierFindings("other-pr", { ...PR_TARGET, number: 7 }),
          earlierFindings("local", { kind: "local" }),
        ],
      });
      for (const activityId of ["other-pr", "missing"]) {
        const error = yield* harness.reviews
          .start({
            reference: REFERENCE,
            incremental: true,
            basedOn: { threadId: EARLIER_REVIEW_THREAD, activityId: EventId.make(activityId) },
            linkSource: "manual",
          })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ stage: "based-on" });
      }
      const local = yield* harness.reviews
        .startLocal({
          projectId: PROJECT_ID,
          incremental: true,
          basedOn: { threadId: EARLIER_REVIEW_THREAD, activityId: EventId.make("other-pr") },
        })
        .pipe(Effect.flip);
      expect(local).toMatchObject({ stage: "based-on" });
      expect(yield* Ref.get(harness.commands)).toEqual([]);

      // The local findings re-review a local review.
      yield* harness.reviews.startLocal({
        projectId: PROJECT_ID,
        incremental: true,
        basedOn: { threadId: EARLIER_REVIEW_THREAD, activityId: EventId.make("local") },
      });
      expect(turnText(yield* Ref.get(harness.commands))).toContain("This is a re-review.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("PullRequestAgentReview.startLocal", () => {
  const turnText = (commands: ReadonlyArray<ReviewRecord>) => {
    const turn = commands.find((command) => command.type === "message.dispatch");
    return turn?.type === "message.dispatch" ? turn.text : "";
  };

  it.effect("reviews a thread's checkout in a new thread on the same branch and worktree", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      const result = yield* harness.reviews.startLocal({
        projectId: PROJECT_ID,
        sourceThreadId: ThreadId.make("source-thread"),
        mode: "deep",
        focus: "error handling",
      });
      expect(result.title).toBe("Deep review: local changes on feature/cache");
      const commands = yield* Ref.get(harness.commands);
      expect(commands.map((command) => command.type)).toEqual([
        "thread.create",
        "review.activity.record",
        "message.dispatch",
        "review.activity.record",
      ]);
      expect(commands[0]).toMatchObject({
        threadId: result.threadId,
        projectId: PROJECT_ID,
        parentThreadId: "source-thread",
        branch: "feature/cache",
        worktreePath: "/worktrees/project/cache",
        runtimeMode: "approval-required",
        modelSelection: PROJECT_MODEL,
      });
      expect(commands[1]).toMatchObject({
        activity: {
          kind: "viewcode.review.started",
          turnId: null,
          payload: { mode: "deep", focus: "error handling" },
        },
      });
      expect(commands[3]).toMatchObject({
        threadId: "source-thread",
        activity: { payload: { kind: "spawn", review: "deep", toThreadId: result.threadId } },
      });
      const text = turnText(commands);
      expect(text).toContain("Deep review of the local changes in /worktrees/project/cache");
      expect(text).toContain("git diff HEAD");
      expect(text).toContain("`git diff <base>...HEAD`");
      expect(text).toContain(`${harness.stateDir}/review-playbooks/deep-review.md`);
      expect(text).toContain("Focus on: error handling");
      expect(text).toContain('pass target "local"');
      expect(text).toContain("Do not change my working tree");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reviews what the reader chose, and records it for the review to be repeated", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      const scopes = [
        { scope: { kind: "uncommitted" }, text: "the uncommitted changes there, and only those" },
        { scope: { kind: "branch" }, text: "with <base> the remote's default branch" },
        { scope: { kind: "branch", base: "release/2.0" }, text: "`git diff release/2.0...HEAD`" },
        { scope: { kind: "commit", sha: "abc1234" }, text: "`git show abc1234`" },
      ] as const;
      const titles = [];
      for (const { scope, text } of scopes) {
        yield* Ref.set(harness.commands, []);
        const started = yield* harness.reviews.startLocal({
          projectId: PROJECT_ID,
          mode: "deep",
          scope,
        });
        titles.push(started.title);
        const commands = yield* Ref.get(harness.commands);
        expect(turnText(commands)).toContain(text);
        expect(commands[1]).toMatchObject({ activity: { payload: { scope } } });
      }
      // The reviewer's title says what it reads.
      expect(titles).toEqual([
        "Deep review: uncommitted changes",
        "Deep review: branch vs its base",
        "Deep review: branch vs release/2.0",
        "Deep review: commit abc1234",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reviews the project's workspace without a source thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      const result = yield* harness.reviews.startLocal({ projectId: PROJECT_ID });
      expect(result.title).toBe("Review: local changes");
      const commands = yield* Ref.get(harness.commands);
      expect(commands[0]).toMatchObject({ branch: null, worktreePath: null });
      expect(commands[0]).not.toHaveProperty("parentThreadId");
      expect(commands).toHaveLength(3);
      expect(turnText(commands)).toContain("local changes in /workspace/project.");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a thread of another project and creates nothing", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      for (const sourceThreadId of ["elsewhere-thread", "missing-thread"]) {
        const error = yield* harness.reviews
          .startLocal({ projectId: PROJECT_ID, sourceThreadId: ThreadId.make(sourceThreadId) })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ stage: "source-thread" });
      }
      expect(yield* Ref.get(harness.commands)).toEqual([]);
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

  it("fixes a pull request opened by another account the reader is signed in with", () => {
    expect(
      PullRequestAgentReview.reviewFindingsModeFor({
        author: "mgai-adi",
        viewer: "CreatorGhost",
        viewerLogins: ["CreatorGhost", "mgai-adi"],
      }),
    ).toBe("fix");
    expect(
      PullRequestAgentReview.reviewFindingsModeFor({
        author: "octocat",
        viewer: "CreatorGhost",
        viewerLogins: ["CreatorGhost", "mgai-adi"],
      }),
    ).toBe("comment");
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
