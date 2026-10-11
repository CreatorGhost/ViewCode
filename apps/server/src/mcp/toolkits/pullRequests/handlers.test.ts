import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type PullRequestRef,
  type ReviewPostFindingsInput,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/unstable/ai";

import { OrchestrationCommandInvariantError } from "../../../orchestration/Errors.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as TurnOrigin from "../../../orchestration/TurnOrigin.ts";
import * as PullRequestAgentReview from "../../../pullRequest/PullRequestAgentReview.ts";
import * as ReviewFindingsPoster from "../../../review/ReviewFindingsPoster.ts";
import {
  listThreadPullRequests,
  PullRequestsToolkitHandlersLive,
  selectFindingsToPost,
} from "./handlers.ts";
import { PullRequestLinkFailedError, PullRequestsToolkit } from "./tools.ts";

const PROJECT_ID = ProjectId.make("project-1");
const THREAD_ID = ThreadId.make("thread-1");

const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size).fill(7),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const invocation = (
  capabilities: ReadonlyArray<McpInvocationContext.McpCapability>,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  threadId: THREAD_ID,
  providerSessionId: "provider-session-1",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities: new Set(capabilities),
  issuedAt: 1,
});

function makeProject(
  repositoryIdentity: OrchestrationProjectShell["repositoryIdentity"] = {
    canonicalKey: "github.com/t3tools/t3code",
    locator: {
      source: "git-remote",
      remoteName: "origin",
      remoteUrl: "git@github.com:T3Tools/T3Code.git",
    },
    provider: "github",
    displayName: "T3Tools/T3Code",
    owner: "T3Tools",
    name: "T3Code",
  },
): OrchestrationProjectShell {
  return {
    id: PROJECT_ID,
    title: "Project",
    workspaceRoot: "/workspace/project",
    defaultModelSelection: null,
    scripts: [],
    repositoryIdentity,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
  };
}

function makeThread(pullRequests: ReadonlyArray<ThreadPullRequestLink>): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests,
    latestTurn: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-20T00:00:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: "2026-08-20T00:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  };
}

function makeLink(
  number: number,
  overrides: Partial<ThreadPullRequestLink> & {
    readonly headBranch?: string;
    readonly baseBranch?: string;
  } = {},
): ThreadPullRequestLink {
  const { headBranch, baseBranch, ...rest } = overrides;
  return {
    host: "github.com",
    repository: "t3tools/t3code",
    number,
    url: `https://github.com/t3tools/t3code/pull/${number}`,
    source: "manual",
    linkedAt: "2026-08-10T00:00:00.000Z",
    snapshot:
      headBranch === undefined
        ? null
        : {
            state: "open",
            title: `PR ${number}`,
            headBranch,
            baseBranch: baseBranch ?? "main",
            isDraft: false,
            updatedAt: null,
            syncedAt: "2026-08-27T00:00:00.000Z",
          },
    stack: null,
    ...rest,
  };
}

interface HarnessOptions {
  readonly thread?: OrchestrationThreadShell | null;
  readonly project?: OrchestrationProjectShell | null;
  readonly reject?: (command: OrchestrationCommand) => OrchestrationCommandInvariantError | null;
  readonly authorship?: PullRequestAgentReview.PullRequestAuthorship;
  /** The thread's activities, as a detail read filtered by kind returns them. */
  readonly activities?: ReadonlyArray<OrchestrationThreadActivity>;
  /** Whether the calling turn was started by the user's own message. */
  readonly startedByUser?: boolean;
  /** Other threads linked to pull requests, with their activities. */
  readonly linkedThreads?: ReadonlyArray<{
    readonly thread: OrchestrationThreadShell;
    readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  }>;
}

const makeHarness = Effect.fn("makePullRequestsToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
  const reviews = yield* Ref.make<
    ReadonlyArray<PullRequestAgentReview.PullRequestAgentReviewInput>
  >([]);
  const authorshipReads = yield* Ref.make<ReadonlyArray<PullRequestRef>>([]);
  const posts = yield* Ref.make<ReadonlyArray<ReviewPostFindingsInput>>([]);
  const originReads = yield* Ref.make<ReadonlyArray<string>>([]);
  const thread = options.thread === undefined ? makeThread([]) : options.thread;
  const project = options.project === undefined ? makeProject() : options.project;
  const dispatch: OrchestrationEngineShape["dispatch"] = (command) =>
    Effect.gen(function* () {
      const rejection = options.reject?.(command) ?? null;
      if (rejection !== null) return yield* rejection;
      yield* Ref.update(commands, (recorded) => [...recorded, command]);
      return { sequence: 1 };
    });
  const dependencies = Layer.mergeAll(
    Layer.mock(ProjectionSnapshotQuery)({
      getThreadShellById: (threadId) =>
        Effect.succeed(threadId === THREAD_ID ? Option.fromNullishOr(thread) : Option.none()),
      getProjectShellById: () => Effect.succeed(Option.fromNullishOr(project)),
      getThreadDetailById: (threadId, query) => {
        const activities =
          threadId === THREAD_ID
            ? options.activities
            : options.linkedThreads?.find((entry) => entry.thread.id === threadId)?.activities;
        return Effect.succeed(
          activities === undefined || (threadId === THREAD_ID && thread === null)
            ? Option.none()
            : Option.some({
                id: threadId,
                activities: activities.filter(
                  (activity) =>
                    query?.activityKinds === undefined ||
                    query.activityKinds.includes(activity.kind),
                ),
              } as unknown as OrchestrationThread),
        );
      },
      listThreadsWithPullRequests: () =>
        Effect.succeed([
          ...(thread === null ? [] : [thread]),
          ...(options.linkedThreads ?? []).map((entry) => entry.thread),
        ]),
    }),
    Layer.mock(OrchestrationEngineService)({
      readEvents: () => Stream.empty,
      dispatch,
      streamDomainEvents: Stream.empty,
      latestSequence: Effect.succeed(0),
    }),
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.mock(PullRequestAgentReview.PullRequestAgentReview)({
      start: (input) =>
        Ref.update(reviews, (all) => [...all, input]).pipe(
          Effect.as({ threadId: ThreadId.make("review-thread"), title: "Review: #7 Fix" }),
        ),
      authorship: (reference) =>
        Ref.update(authorshipReads, (all) => [...all, reference]).pipe(
          Effect.as(options.authorship ?? { author: "octocat", viewer: "octocat" }),
        ),
    }),
    Layer.mock(ReviewFindingsPoster.ReviewFindingsPoster)({
      post: (input) =>
        Ref.update(posts, (all) => [...all, input]).pipe(
          Effect.as({
            url: input.target.url,
            findings: input.findings.map(({ key }, index) => ({
              key,
              placement: index === 0 ? ("inline" as const) : ("body" as const),
            })),
            headMoved: false,
          }),
        ),
    }),
    Layer.mock(TurnOrigin.TurnOrigin)({
      startedByUser: ({ turnId }) =>
        Ref.update(originReads, (all) => [...all, turnId]).pipe(
          Effect.as(options.startedByUser ?? false),
        ),
    }),
  );
  const toolkit = yield* PullRequestsToolkit.pipe(
    Effect.provide(PullRequestsToolkitHandlersLive.pipe(Layer.provide(dependencies))),
  );
  const call = <Name extends keyof typeof PullRequestsToolkit.tools>(
    name: Name,
    params: Parameters<typeof toolkit.handle<Name>>[1],
    capabilities: ReadonlyArray<McpInvocationContext.McpCapability> = ["pull-requests"],
  ) =>
    toolkit.handle(name, params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      // Failure mode is "error", so a delivered result is always the success shape.
      Effect.map(
        (chunk) => chunk.at(-1)!.result as Tool.Success<(typeof PullRequestsToolkit.tools)[Name]>,
      ),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
      Effect.provide(dependencies),
    );
  return { commands, reviews, authorshipReads, posts, originReads, call };
});

describe("pull request toolkit handlers", () => {
  it.effect("starts a review on the thread's project, falling back to the thread's model", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("review_pull_request", {
        repository: "T3Tools/T3Code",
        number: 7,
        mode: "deep",
        focus: "migrations",
        findingsMode: "fix",
      });
      expect(result).toMatchObject({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 7,
        threadId: "review-thread",
      });
      expect(yield* Ref.get(harness.reviews)).toMatchObject([
        {
          reference: {
            projectId: PROJECT_ID,
            host: "github.com",
            repository: "t3tools/t3code",
            number: 7,
          },
          mode: "deep",
          focus: "migrations",
          findingsMode: "fix",
          fallbackModelSelection: { instanceId: "codex", model: "gpt-5" },
          linkSource: "agent",
        },
      ]);
    }),
  );

  describe("submit_review_findings", () => {
    const report = {
      verdict: "request-changes",
      mergeConfidence: 2,
      reviewEffort: 3,
      findings: [
        {
          severity: "blocker",
          confidence: 90,
          path: "src/a.ts",
          line: 4,
          title: "Unchecked input",
          detail: "The handler passes the query straight to the shell.",
        },
      ],
      needsChecking: [],
    } as const;

    it.effect("records the findings on the thread against its linked pull request", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          thread: makeThread([
            makeLink(3, { linkedAt: "2026-08-01T00:00:00.000Z" }),
            makeLink(7, { url: "https://github.com/T3Tools/T3Code/pull/7" }),
          ]),
        });
        const result = yield* harness.call("submit_review_findings", report);
        expect(result).toMatchObject({ target: "pull-request", findings: 1, needsChecking: 0 });
        const commands = yield* Ref.get(harness.commands);
        expect(commands).toMatchObject([
          {
            type: "thread.activity.append",
            threadId: THREAD_ID,
            activity: {
              kind: "viewcode.review.findings",
              summary: "Review: request changes, 1 finding",
              turnId: null,
              payload: {
                ...report,
                // The link most recently made, not the first.
                target: {
                  kind: "pull-request",
                  host: "github.com",
                  repository: "t3tools/t3code",
                  number: 7,
                  url: "https://github.com/T3Tools/T3Code/pull/7",
                },
              },
            },
          },
        ]);
      }),
    );

    it.effect("pins pull request findings to the commit the review started on", () =>
      Effect.gen(function* () {
        const started = (headSha: string): OrchestrationThreadActivity => ({
          id: EventId.make(`started-${headSha}`),
          tone: "info",
          kind: "viewcode.review.started",
          summary: "Review started",
          payload: { headSha, timelineBypass: true },
          turnId: null,
          createdAt: "2026-08-20T00:00:00.000Z",
        });
        const harness = yield* makeHarness({
          thread: makeThread([makeLink(7)]),
          activities: [started("aaaaaaa"), started("bbbbbbb")],
        });
        yield* harness.call("submit_review_findings", report);
        yield* harness.call("submit_review_findings", { ...report, target: "local" });
        const [pullRequest, local] = yield* Ref.get(harness.commands);
        expect(pullRequest).toMatchObject({ activity: { payload: { headSha: "bbbbbbb" } } });
        // A local review has no pull request commit to pin to.
        expect(
          local?.type === "thread.activity.append" ? local.activity.payload : {},
        ).not.toHaveProperty("headSha");
      }),
    );

    it.effect("records comments for somebody else's pull request and fixes for the reader's", () =>
      Effect.gen(function* () {
        const theirs = yield* makeHarness({
          thread: makeThread([makeLink(7)]),
          authorship: { author: "Octocat", viewer: "bilal" },
        });
        yield* theirs.call("submit_review_findings", report);
        expect(yield* Ref.get(theirs.authorshipReads)).toEqual([
          { projectId: PROJECT_ID, host: "github.com", repository: "t3tools/t3code", number: 7 },
        ]);
        expect(yield* Ref.get(theirs.commands)).toMatchObject([
          { activity: { payload: { mode: "comment" } } },
        ]);

        const mine = yield* makeHarness({
          thread: makeThread([makeLink(7)]),
          authorship: { author: "Bilal", viewer: "bilal" },
        });
        yield* mine.call("submit_review_findings", report);
        expect(yield* Ref.get(mine.commands)).toMatchObject([
          { activity: { payload: { mode: "fix" } } },
        ]);
      }),
    );

    it.effect("takes the reviewer's mode over the pull request's author", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          thread: makeThread([makeLink(7)]),
          authorship: { author: "octocat", viewer: "bilal" },
        });
        yield* harness.call("submit_review_findings", { ...report, mode: "fix" });
        expect(yield* Ref.get(harness.authorshipReads)).toEqual([]);
        expect(yield* Ref.get(harness.commands)).toMatchObject([
          { activity: { payload: { mode: "fix" } } },
        ]);
      }),
    );

    it.effect("records fixes for local changes, whatever mode was asked for", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        yield* harness.call("submit_review_findings", { ...report, mode: "comment" });
        expect(yield* Ref.get(harness.authorshipReads)).toEqual([]);
        expect(yield* Ref.get(harness.commands)).toMatchObject([
          { activity: { payload: { target: { kind: "local" }, mode: "fix" } } },
        ]);
      }),
    );

    it.effect("records a review of local changes when no pull request is linked", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness();
        expect(yield* harness.call("submit_review_findings", report)).toMatchObject({
          target: "local",
        });
        const error = yield* harness
          .call("submit_review_findings", { ...report, target: "pull-request" })
          .pipe(Effect.flip);
        expect(error._tag).toBe("ReviewFindingsTargetMissingError");
        expect(yield* Ref.get(harness.commands)).toMatchObject([
          { activity: { payload: { target: { kind: "local" } } } },
        ]);
      }),
    );

    it.effect("records a local target when asked, even with a linked pull request", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({ thread: makeThread([makeLink(7)]) });
        yield* harness.call("submit_review_findings", { ...report, target: "local" });
        expect(yield* Ref.get(harness.commands)).toMatchObject([
          { activity: { payload: { target: { kind: "local" } } } },
        ]);
      }),
    );
  });

  describe("post_review_findings", () => {
    const TURN_ID = TurnId.make("turn-1");
    const finding = (severity: "blocker" | "important" | "nit", title: string) => ({
      severity,
      confidence: 90,
      path: "src/a.ts",
      line: 4,
      title,
      detail: `${title} breaks it.`,
    });
    const findingsActivity = (
      id: string,
      target: object = {
        kind: "pull-request",
        host: "github.com",
        repository: "t3tools/t3code",
        number: 7,
        url: "https://github.com/t3tools/t3code/pull/7",
      },
    ): OrchestrationThreadActivity => ({
      id: EventId.make(id),
      tone: "info",
      kind: "viewcode.review.findings",
      summary: "Review: request changes, 3 findings",
      payload: {
        verdict: "request-changes",
        mergeConfidence: 2,
        reviewEffort: 2,
        findings: [
          finding("blocker", "First blocker"),
          finding("nit", "A nit"),
          finding("blocker", "Second blocker"),
        ],
        needsChecking: [finding("important", "Maybe")],
        target,
        mode: "comment",
      },
      turnId: null,
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    const postedActivity = (findingsActivityId: string, keys: ReadonlyArray<string>) =>
      ({
        id: EventId.make(`posted-${keys.join("-")}`),
        tone: "info",
        kind: "viewcode.review.posted",
        summary: "Posted",
        payload: {
          findingsActivityId,
          verdict: "comment",
          url: "https://github.com/t3tools/t3code/pull/7",
          findings: keys.map((key) => ({ key, placement: "inline" })),
        },
        turnId: null,
        createdAt: "2026-08-21T00:00:00.000Z",
      }) satisfies OrchestrationThreadActivity;
    const running = (pullRequests: ReadonlyArray<ThreadPullRequestLink> = [makeLink(7)]) => ({
      ...makeThread(pullRequests),
      session: {
        threadId: THREAD_ID,
        status: "running" as const,
        providerName: "codex",
        runtimeMode: "full-access" as const,
        activeTurnId: TURN_ID,
        lastError: null,
        updatedAt: "2026-08-20T00:00:00.000Z",
      },
    });

    it.effect("posts the findings the user asked for, as a comment, in their turn", () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness({
          thread: running(),
          activities: [findingsActivity("old"), findingsActivity("latest")],
          startedByUser: true,
        });
        const result = yield* harness.call("post_review_findings", { severities: ["blocker"] });
        expect(yield* Ref.get(harness.originReads)).toEqual([TURN_ID]);
        expect(result).toEqual({
          url: "https://github.com/t3tools/t3code/pull/7",
          posted: 2,
          inline: 1,
          inText: 1,
          alreadyPosted: 0,
          headMoved: false,
        });
        expect(yield* Ref.get(harness.posts)).toMatchObject([
          {
            reviewThreadId: THREAD_ID,
            findingsActivityId: "latest",
            verdict: "comment",
            overallComment: "",
            findings: [
              { key: "finding:0", finding: { title: "First blocker" } },
              { key: "finding:2", finding: { title: "Second blocker" } },
            ],
          },
        ]);
      }),
    );

    it.effect("refuses, posting nothing, in a turn the user did not start", () =>
      Effect.gen(function* () {
        // An agent's message, a child agent's brief, a wake or a server-started review.
        const agentTurn = yield* makeHarness({
          thread: running(),
          activities: [findingsActivity("latest")],
          startedByUser: false,
        });
        const error = yield* agentTurn.call("post_review_findings", {}).pipe(Effect.flip);
        expect(error._tag).toBe("ReviewPostNotRequestedError");
        expect(error.message).toContain(
          "Posting needs the user's explicit request in this chat or a click in the Review panel",
        );
        expect(yield* Ref.get(agentTurn.posts)).toEqual([]);

        // No running turn at all.
        const idle = yield* makeHarness({
          thread: makeThread([makeLink(7)]),
          activities: [findingsActivity("latest")],
          startedByUser: true,
        });
        expect((yield* idle.call("post_review_findings", {}).pipe(Effect.flip))._tag).toBe(
          "ReviewPostNotRequestedError",
        );
        expect(yield* Ref.get(idle.originReads)).toEqual([]);
        expect(yield* Ref.get(idle.posts)).toEqual([]);
      }),
    );

    it.effect("posts from the review thread linked to the same pull request", () =>
      Effect.gen(function* () {
        const reviewThread = { ...makeThread([makeLink(7)]), id: ThreadId.make("review-1") };
        const harness = yield* makeHarness({
          thread: running(),
          activities: [],
          startedByUser: true,
          linkedThreads: [
            {
              thread: reviewThread,
              activities: [findingsActivity("review"), postedActivity("review", ["finding:0"])],
            },
            {
              thread: { ...makeThread([makeLink(8)]), id: ThreadId.make("other-pr") },
              activities: [findingsActivity("other")],
            },
          ],
        });
        const result = yield* harness.call("post_review_findings", {
          keys: ["finding:0", "check:0"],
          verdict: "request-changes",
          overallComment: "Two things.",
        });
        expect(result).toMatchObject({ posted: 1, alreadyPosted: 1 });
        expect(yield* Ref.get(harness.posts)).toMatchObject([
          {
            reviewThreadId: "review-1",
            findingsActivityId: "review",
            verdict: "request-changes",
            overallComment: "Two things.",
            findings: [{ key: "check:0" }],
          },
        ]);
      }),
    );

    it.effect("says why there is nothing to post", () =>
      Effect.gen(function* () {
        const none = yield* makeHarness({ thread: running([]), startedByUser: true });
        expect(yield* none.call("post_review_findings", {}).pipe(Effect.flip)).toMatchObject({
          _tag: "ReviewPostNothingError",
          reason: "no-findings",
        });
        const local = yield* makeHarness({
          thread: running([]),
          activities: [findingsActivity("local", { kind: "local" })],
          startedByUser: true,
        });
        expect(yield* local.call("post_review_findings", {}).pipe(Effect.flip)).toMatchObject({
          reason: "local",
        });
        expect(yield* Ref.get(local.posts)).toEqual([]);
      }),
    );
  });

  it.effect("refuses a credential without the pull-requests capability", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("list_thread_pull_requests", {}, ["preview"])
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "McpCapabilityUnavailableError",
        capability: "pull-requests",
        threadId: THREAD_ID,
      });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by URL with source agent on the token's thread", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 123,
        url: "https://github.com/T3Tools/T3Code/pull/123/files",
        alreadyLinked: false,
      });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.link",
          threadId: THREAD_ID,
          host: "github.com",
          repository: "t3tools/t3code",
          number: 123,
          source: "agent",
        },
      ]);
    }),
  );

  it.effect("watching an unlinked pull request links it in the same command", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("watch_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(result).toMatchObject({ number: 9, watching: true, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        {
          type: "thread.pull-request.watch",
          number: 9,
          watching: true,
          link: { url: "https://github.com/t3tools/t3code/pull/9", source: "agent" },
        },
      ]);
    }),
  );

  it.effect("reports why a watch was refused, and stops without a command when not watched", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(1, { headBranch: "done" }), makeLink(2)]),
        reject: (command) =>
          command.type === "thread.pull-request.watch"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "the pull request is merged",
              })
            : null,
      });
      const error = yield* harness
        .call("watch_pull_request", { repository: "t3tools/t3code", number: 1 })
        .pipe(Effect.flip);
      expect(error).toMatchObject({
        _tag: "PullRequestNotWatchableError",
        reason: "the pull request is merged",
      });
      expect(
        yield* harness.call("unwatch_pull_request", { repository: "t3tools/t3code", number: 2 }),
      ).toMatchObject({ watching: false, wasWatching: false });
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("links by repository and number, defaulting the host to the project's", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call("link_pull_request", {
        repository: "T3Tools/Other",
        number: 7,
      });
      expect(result).toEqual({
        host: "github.com",
        repository: "t3tools/other",
        number: 7,
        url: "https://github.com/t3tools/other/pull/7",
        alreadyLinked: false,
      });
    }),
  );

  it.effect("builds the URL in the project host's own shape", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "gitlab.com/group/sub/project",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "git@gitlab.com:group/sub/project.git",
          },
          provider: "gitlab",
          displayName: "group/sub/project",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "group/sub/project",
        number: 42,
      });
      expect(result.url).toBe("https://gitlab.com/group/sub/project/-/merge_requests/42");
      expect(result.host).toBe("gitlab.com");
    }),
  );

  it.effect("links a numeric Forgejo reference with its remote's web origin and mount path", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        project: makeProject({
          canonicalKey: "forge.example/git/owner/repo",
          locator: {
            source: "git-remote",
            remoteName: "origin",
            remoteUrl: "http://forge.example:3000/git/owner/repo.git",
          },
          provider: "forgejo",
          displayName: "git/owner/repo",
        }),
      });
      const result = yield* harness.call("link_pull_request", {
        repository: "git/owner/repo",
        number: 42,
      });
      expect(result).toEqual({
        host: "forge.example:3000",
        repository: "git/owner/repo",
        number: 42,
        url: "http://forge.example:3000/git/owner/repo/pulls/42",
        alreadyLinked: false,
      });
      const other = yield* harness.call("link_pull_request", {
        host: "other.example",
        repository: "owner/repo",
        number: 42,
      });
      expect(other.url).toBe("https://other.example/owner/repo/pull/42");
    }),
  );

  it.effect("rejects a target that names neither a URL nor repository and number", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const error = yield* harness
        .call("link_pull_request", { repository: "x/y" })
        .pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestTargetIncompleteError" });
      const unknown = yield* harness
        .call("link_pull_request", {
          url: "https://github.com/t3tools/t3code/issues/1?token=private-value",
        })
        .pipe(Effect.flip);
      expect(unknown).toMatchObject({ _tag: "PullRequestUrlInvalidError" });
      expect(unknown.message).not.toContain("private-value");
      expect(yield* Ref.get(harness.commands)).toEqual([]);
    }),
  );

  it.effect("treats a duplicate link as alreadyLinked rather than an error", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(123)]),
        reject: (command) =>
          command.type === "thread.pull-request.link"
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "already linked",
              })
            : null,
      });
      const result = yield* harness.call("link_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/123",
      });
      expect(result.alreadyLinked).toBe(true);
    }),
  );

  it.effect("unlinks a linked pull request and reports a missing one as wasLinked=false", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([makeLink(5)]),
        reject: (command) =>
          command.type === "thread.pull-request.unlink" && command.number !== 5
            ? new OrchestrationCommandInvariantError({
                commandType: command.type,
                detail: "not linked",
              })
            : null,
      });
      const linked = yield* harness.call("unlink_pull_request", {
        repository: "t3tools/t3code",
        number: 5,
      });
      expect(linked).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 5,
        wasLinked: true,
      });
      const missing = yield* harness.call("unlink_pull_request", {
        url: "https://github.com/t3tools/t3code/pull/9",
      });
      expect(missing.wasLinked).toBe(false);
      expect(yield* Ref.get(harness.commands)).toMatchObject([
        { type: "thread.pull-request.unlink", number: 5 },
      ]);
    }),
  );

  it("reports an older Forgejo link's HTTP port when listing thread links", () => {
    const result = listThreadPullRequests(
      makeThread([
        makeLink(42, {
          host: "forge.example",
          url: "http://forge.example:3000/t3tools/t3code/pulls/42",
        }),
      ]),
    );
    expect(result.pullRequests[0]?.host).toBe("forge.example:3000");
  });

  it.effect("fails cleanly when the token's thread no longer exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({ thread: null });
      const error = yield* harness.call("list_thread_pull_requests", {}).pipe(Effect.flip);
      expect(error).toMatchObject({ _tag: "PullRequestThreadNotFoundError", threadId: THREAD_ID });
    }),
  );

  it.effect("lists visible links with host state and derived chain order", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        thread: makeThread([
          makeLink(3, { headBranch: "feat-c", baseBranch: "feat-b", source: "agent" }),
          makeLink(1, { headBranch: "feat-a", baseBranch: "main", source: "created" }),
          makeLink(2, { headBranch: "feat-b", baseBranch: "feat-a", source: "agent" }),
          makeLink(9, { source: "stack-dismissed" }),
          makeLink(10),
        ]),
      });
      const result = yield* harness.call("list_thread_pull_requests", {});
      expect(result.pullRequests.map((entry) => entry.number)).toEqual([3, 1, 2, 10]);
      expect(result.pullRequests[0]).toEqual({
        host: "github.com",
        repository: "t3tools/t3code",
        number: 3,
        url: "https://github.com/t3tools/t3code/pull/3",
        source: "agent",
        watching: false,
        state: "open",
        title: "PR 3",
        headBranch: "feat-c",
        baseBranch: "feat-b",
        isDraft: false,
        stack: { kind: "derived", position: 3, size: 3 },
      });
      expect(result.pullRequests[3]).toMatchObject({
        number: 10,
        state: null,
        title: null,
        headBranch: null,
        stack: null,
      });
      expect(result.chains).toEqual([
        { kind: "derived", numbers: [1, 2, 3] },
        { kind: "derived", numbers: [10] },
      ]);
    }),
  );
});

describe("listThreadPullRequests", () => {
  it("reports a native stack position for each member", () => {
    const stack = {
      kind: "native" as const,
      id: "stack-1",
      number: 1,
      url: "https://github.com/t3tools/t3code/stack/1",
      base: "main",
      layers: [
        { number: 1, headBranch: "a", state: "open" as const },
        { number: 2, headBranch: "b", state: "open" as const },
      ],
    };
    const result = listThreadPullRequests({
      pullRequests: [
        makeLink(2, { stack, source: "stack" }),
        makeLink(1, { stack, source: "created" }),
      ],
    });
    expect(result.pullRequests.map((entry) => [entry.number, entry.stack])).toEqual([
      [2, { kind: "native", position: 2, size: 2 }],
      [1, { kind: "native", position: 1, size: 2 }],
    ]);
    expect(result.chains).toEqual([{ kind: "native", numbers: [1, 2] }]);
  });
});

it("keeps failure diagnostics as the cause rather than exposing them in the tool message", () => {
  const cause = new Error("database internals");
  const failure = new PullRequestLinkFailedError({ cause });
  expect(failure.message).toBe("Could not link the pull request.");
  expect(failure.cause).toBe(cause);
});

describe("selectFindingsToPost", () => {
  const finding = (severity: "blocker" | "nit") => ({
    severity,
    confidence: 90,
    path: "a.ts",
    title: severity,
    detail: "d",
  });
  const payload = {
    findings: [finding("blocker"), finding("nit")],
    needsChecking: [finding("nit")],
  };

  it("takes every reported finding by default and unsettled ones only by key", () => {
    expect(selectFindingsToPost(payload, {}, new Set())).toMatchObject({
      selected: [{ key: "finding:0" }, { key: "finding:1" }],
      alreadyPosted: 0,
    });
    expect(selectFindingsToPost(payload, { keys: ["check:0"] }, new Set())).toMatchObject({
      selected: [{ key: "check:0" }],
    });
  });

  it("refuses unknown keys, empty choices and choices already posted", () => {
    expect(selectFindingsToPost(payload, { keys: ["finding:9"] }, new Set())).toBe("unknown-key");
    expect(
      selectFindingsToPost(
        { findings: [finding("nit")], needsChecking: [] },
        { severities: ["blocker"] },
        new Set(),
      ),
    ).toBe("none-selected");
    expect(selectFindingsToPost(payload, { severities: ["blocker"] }, new Set(["finding:0"]))).toBe(
      "already-posted",
    );
  });
});
