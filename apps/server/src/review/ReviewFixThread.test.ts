import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GitPreparePullRequestThreadInput,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ReviewFindingToFix,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ReviewFixThread from "./ReviewFixThread.ts";

const PROJECT_ID = ProjectId.make("project-1");
const REVIEW_THREAD_ID = ThreadId.make("review-thread");
const PROJECT_MODEL = { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet" };
const REVIEW_MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" };
const PR_TARGET = {
  kind: "pull-request",
  host: "github.com",
  repository: "t3tools/t3code",
  number: 42,
  url: "https://github.com/t3tools/t3code/pull/42",
} as const;

const project: OrchestrationProjectShell = {
  id: PROJECT_ID,
  title: "Project",
  workspaceRoot: "/workspace/project",
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const reviewThread: OrchestrationThreadShell = {
  id: REVIEW_THREAD_ID,
  projectId: PROJECT_ID,
  title: "Review: #42 Cache the probe",
  modelSelection: REVIEW_MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/workspace/project-feature",
  pullRequests: [],
  latestTurn: null,
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
};

const findings: ReadonlyArray<ReviewFindingToFix> = [
  {
    finding: {
      severity: "blocker",
      confidence: 90,
      path: "src/probe.ts",
      line: 3,
      title: "Cache never expires",
      detail: "Entries are written without a TTL.",
    },
    needsChecking: false,
  },
];

const makeHarness = (options: {
  readonly defaultModel?: typeof PROJECT_MODEL;
  readonly checkoutFails?: boolean;
}) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const checkouts = yield* Ref.make<ReadonlyArray<GitPreparePullRequestThreadInput>>([]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (threadId) =>
          Effect.succeed(threadId === REVIEW_THREAD_ID ? Option.some(reviewThread) : Option.none()),
        getProjectShellById: (projectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      }),
      Layer.mock(OrchestrationEngineService)({
        readEvents: () => Stream.empty,
        streamDomainEvents: Stream.empty,
        latestSequence: Effect.succeed(0),
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({ sequence: 1 })),
      }),
      Layer.mock(GitWorkflowService)({
        preparePullRequestThread: (input) =>
          Ref.update(checkouts, (all) => [...all, input]).pipe(
            Effect.andThen(
              options.checkoutFails === true
                ? Effect.fail(
                    new GitManagerError({
                      operation: "preparePullRequestThread",
                      cwd: input.cwd,
                      detail: "the branch is checked out in the main repository",
                    }),
                  )
                : Effect.succeed({
                    pullRequest: {
                      number: 42,
                      title: "Cache the probe",
                      url: PR_TARGET.url,
                      baseBranch: "main",
                      headBranch: "cache-probe",
                      state: "open" as const,
                    },
                    branch: "cache-probe",
                    worktreePath: "/workspace/.worktrees/cache-probe",
                    isOnPullRequestHead: true,
                  }),
            ),
          ),
      }),
      ServerSettings.layerTest({
        defaultModelSelection: options.defaultModel ?? null,
        defaultRuntimeMode: "approval-required",
      }),
    );
    const service = yield* ReviewFixThread.ReviewFixThread.pipe(
      Effect.provide(ReviewFixThread.layer.pipe(Layer.provide(dependencies))),
    );
    return { service, commands, checkouts };
  });

describe("ReviewFixThread", () => {
  it.effect("checks the pull request out for a new linked session and sends the findings", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ defaultModel: PROJECT_MODEL });
      const result = yield* harness.service.start({
        reviewThreadId: REVIEW_THREAD_ID,
        target: PR_TARGET,
        findings,
      });
      expect(result.title).toBe("Fix review findings: #42 Cache the probe");
      expect(yield* Ref.get(harness.checkouts)).toEqual([
        {
          cwd: "/workspace/project",
          reference: PR_TARGET.url,
          // Its own worktree, so the user's checkout does not move.
          mode: "worktree",
          threadId: result.threadId,
        },
      ]);
      const [create, link, turn] = yield* Ref.get(harness.commands);
      expect(create).toMatchObject({
        type: "thread.create",
        threadId: result.threadId,
        projectId: PROJECT_ID,
        modelSelection: PROJECT_MODEL,
        runtimeMode: "approval-required",
        branch: "cache-probe",
        worktreePath: "/workspace/.worktrees/cache-probe",
      });
      expect(link).toMatchObject({
        type: "thread.pull-request.link",
        threadId: result.threadId,
        host: "github.com",
        repository: "t3tools/t3code",
        number: 42,
        source: "manual",
      });
      const text = turn?.type === "thread.turn.start" ? turn.message.text : "";
      expect(text).toContain('from "Review: #42 Cache the probe" on PR #42');
      expect(text).toContain("verify each against the code first");
      expect(text).toContain("1. Cache never expires");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("works where a local review did, on the reviewer's model without a default", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({});
      const result = yield* harness.service.start({
        reviewThreadId: REVIEW_THREAD_ID,
        target: { kind: "local" },
        findings,
      });
      expect(result.title).toBe("Fix review findings: Review: #42 Cache the probe");
      expect(yield* Ref.get(harness.checkouts)).toEqual([]);
      const sent = yield* Ref.get(harness.commands);
      expect(sent.map((command) => command.type)).toEqual(["thread.create", "thread.turn.start"]);
      expect(sent[0]).toMatchObject({
        modelSelection: REVIEW_MODEL,
        branch: "feature",
        worktreePath: "/workspace/project-feature",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("creates nothing when the checkout fails, and says why", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ checkoutFails: true });
      const error = yield* harness.service
        .start({ reviewThreadId: REVIEW_THREAD_ID, target: PR_TARGET, findings })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "ReviewFixThreadError", stage: "checkout" });
      expect(error.message).toContain("the branch is checked out in the main repository");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
