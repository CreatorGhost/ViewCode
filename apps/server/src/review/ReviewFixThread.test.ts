import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  GitManagerError,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  RunId,
  CheckpointId,
  CheckpointScopeId,
  type GitPreparePullRequestThreadInput,
  type OrchestrationV2ServerCommand,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationV2ThreadShell,
  type ReviewFindingToFix,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ThreadManagementService } from "../orchestration-v2/ThreadManagementService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import { ProjectStoreV2 } from "../orchestration-v2/ProjectStore.ts";
import { ReviewActivityStoreV2 } from "./ReviewActivityStoreV2.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ReviewFixThread from "./ReviewFixThread.ts";

type ReviewRecord =
  | OrchestrationV2ServerCommand
  | ({ readonly type: "review.activity.record" } & Parameters<
      ReviewActivityStoreV2["Service"]["append"]
    >[0]);

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
  defaultThreadEnvMode: null,
  autoPull: false,
  faviconPath: null,
  projectIcon: null,
  scripts: [],
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
};

const reviewThread: OrchestrationV2ThreadShell = {
  ...liveThreadShell(REVIEW_THREAD_ID),
  id: REVIEW_THREAD_ID,
  projectId: PROJECT_ID,
  title: "Review: #42 Cache the probe",
  modelSelection: REVIEW_MODEL,
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "feature",
  worktreePath: "/workspace/project-feature",
  pullRequests: [],
  activeRunId: null,
  status: "idle",
  createdAt: DateTime.makeUnsafe("2026-08-01T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-08-20T00:00:00.000Z"),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  latestUserMessageAt: null,
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

const FIX_THREAD_ID = ThreadId.make("fix-thread");

const fixStarted: OrchestrationThreadActivity = {
  id: EventId.make("fix-started"),
  tone: "info",
  kind: "viewcode.review.fix-started",
  summary: "Started fixing review findings",
  payload: {
    reviewThreadId: REVIEW_THREAD_ID,
    findingsActivityId: "findings",
    turnCountBefore: 0,
    timelineBypass: true,
  },
  turnId: null,
  createdAt: "2026-08-20T00:00:00.000Z",
};

const makeHarness = (options: {
  readonly defaultModel?: typeof PROJECT_MODEL;
  readonly checkoutFails?: boolean;
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** The fix session to undo: its activities, turn count and session status. */
  readonly fixThread?: {
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
    readonly turnCount: number;
    readonly status?: "running" | "ready";
  };
}) =>
  Effect.gen(function* () {
    const commands = yield* Ref.make<ReadonlyArray<ReviewRecord>>([]);
    const checkouts = yield* Ref.make<ReadonlyArray<GitPreparePullRequestThreadInput>>([]);
    const dependencies = Layer.mergeAll(
      Layer.mock(ProjectStoreV2)({
        getShell: (projectId) =>
          Effect.succeed(projectId === PROJECT_ID ? Option.some(project) : Option.none()),
      }),
      Layer.mock(ProjectionStoreV2)({
        getThreadShell: (threadId) =>
          Effect.succeed(
            threadId === REVIEW_THREAD_ID
              ? reviewThread
              : threadId === FIX_THREAD_ID && options.fixThread !== undefined
                ? {
                    ...reviewThread,
                    id: FIX_THREAD_ID,
                    activeRunId:
                      options.fixThread.status === "running" ? RunId.make("run:fix") : null,
                  }
                : null,
          ),
      }),
      Layer.mock(ReviewActivityStoreV2)({
        list: () => Effect.succeed(options.fixThread?.activities ?? []),
        append: (command) =>
          Ref.update(commands, (all) => [
            ...all,
            { type: "review.activity.record" as const, ...command },
          ]),
      }),
      Layer.mock(ThreadManagementService)({
        getShellSnapshot: () =>
          Effect.succeed({
            threads: options.threads ?? [reviewThread],
            projects: [project],
          } as never),
        getThreadProjection: () =>
          Effect.succeed({
            runs: Array.from({ length: options.fixThread?.turnCount ?? 0 }, (_, index) => ({
              ordinal: index + 1,
            })),
            checkpoints: [
              {
                id: CheckpointId.make("baseline"),
                scopeId: CheckpointScopeId.make("scope:fix"),
                appRunOrdinal: null,
                status: "ready",
              },
            ],
          } as never),
        dispatch: (command) =>
          Ref.update(commands, (all) => [...all, command]).pipe(Effect.as({} as never)),
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
        findingsActivityId: EventId.make("findings"),
      });
      expect(result.title).toBe("Fix review findings: #42 Cache the probe");
      expect(yield* Ref.get(harness.checkouts)).toEqual([
        {
          cwd: "/workspace/project",
          reference: PR_TARGET.url,
          // The PR worktree, so the user's checkout does not move.
          mode: "worktree",
          threadId: result.threadId,
        },
      ]);
      const [create, link, started, turn] = yield* Ref.get(harness.commands);
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
      // What the session fixes and where to go back to, outside any turn.
      expect(started).toMatchObject({
        type: "review.activity.record",
        threadId: result.threadId,
        activity: {
          kind: "viewcode.review.fix-started",
          turnId: null,
          payload: {
            reviewThreadId: REVIEW_THREAD_ID,
            findingsActivityId: "findings",
            turnCountBefore: 0,
          },
        },
      });
      const text = turn?.type === "message.dispatch" ? turn.text : "";
      expect(text).toContain('from "Review: #42 Cache the probe" on PR #42');
      expect(text).toContain("verify each against the code first");
      expect(text).toContain("1. Cache never expires");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses a checkout where another session is running or has an active turn", () =>
    Effect.gen(function* () {
      for (const status of ["running", "ready"] as const) {
        const harness = yield* makeHarness({
          threads: [
            {
              ...reviewThread,
              id: FIX_THREAD_ID,
              worktreePath: "/workspace/.worktrees/cache-probe",
              status: status === "running" ? "running" : "idle",
              activeRunId: status === "running" ? null : RunId.make("active-turn"),
            },
          ],
        });
        const error = yield* harness.service
          .start({ reviewThreadId: REVIEW_THREAD_ID, target: PR_TARGET, findings })
          .pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ReviewFixThreadError", stage: "checkout-busy" });
        expect(error.message).toBe(
          "Another session is working in this pull request's checkout. Stop or finish it before starting a new fix session.",
        );
        expect(yield* Ref.get(harness.checkouts)).toHaveLength(1);
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("allows an idle session to share the pull request's checkout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        threads: [
          {
            ...reviewThread,
            id: FIX_THREAD_ID,
            worktreePath: "/workspace/.worktrees/cache-probe",
            status: "idle",
            activeRunId: null,
          },
        ],
      });
      const result = yield* harness.service.start({
        reviewThreadId: REVIEW_THREAD_ID,
        target: PR_TARGET,
        findings,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.create",
          threadId: result.threadId,
          worktreePath: "/workspace/.worktrees/cache-probe",
        },
        { type: "thread.pull-request.link" },
        { type: "review.activity.record" },
        { type: "message.dispatch", threadId: result.threadId },
      ]);
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
      expect(sent.map((command) => command.type)).toEqual([
        "thread.create",
        "review.activity.record",
        "message.dispatch",
      ]);
      expect(sent[0]).toMatchObject({
        modelSelection: REVIEW_MODEL,
        branch: "feature",
        worktreePath: "/workspace/project-feature",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("undoes a fix session back to before its fix through the checkpoint revert", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        fixThread: { activities: [fixStarted], turnCount: 2, status: "ready" },
      });
      expect(yield* harness.service.undo({ threadId: FIX_THREAD_ID })).toEqual({
        turnCount: 0,
        undoneTurns: 2,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "checkpoint.rollback",
          threadId: FIX_THREAD_ID,
          checkpointId: "baseline",
          scopeId: "scope:fix",
          restoreFiles: true,
        },
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("undoes nothing that is not a fix, still running, or already undone", () =>
    Effect.gen(function* () {
      const cases = [
        [{ activities: [], turnCount: 2 }, "not-a-fix"],
        [{ activities: [fixStarted], turnCount: 1, status: "running" as const }, "running"],
        [{ activities: [fixStarted], turnCount: 0 }, "nothing"],
      ] as const;
      for (const [fixThread, stage] of cases) {
        const harness = yield* makeHarness({ fixThread });
        const error = yield* harness.service.undo({ threadId: FIX_THREAD_ID }).pipe(Effect.flip);
        expect(error).toMatchObject({ _tag: "ReviewUndoFixesError", stage });
        expect(yield* Ref.get(harness.commands)).toEqual([]);
      }
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
