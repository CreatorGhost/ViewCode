import {
  threadPullRequestsOf,
  threadPullRequestKeysEqual,
} from "@t3tools/shared/threadPullRequests";
import {
  EventId,
  TurnId,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  REVIEW_STARTED_ACTIVITY_KIND,
  ReviewStartedActivityPayload,
  type OrchestrationThreadActivity,
  type ReviewFinding,
  type ReviewFindingsActivityPayload,
  type ReviewFindingsMode,
  type ReviewFindingsTarget,
  CommandId,
  pullRequestHostOf,
  type OrchestrationProjectShell,
  type OrchestrationV2ThreadShell,
  type SourceControlProviderKind,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { sourceControlRepositorySelector } from "@t3tools/shared/sourceControl";
import {
  normalizeThreadPullRequestKey,
  resolveThreadPullRequestChains,
  threadPullRequestKeyOf,
  visibleThreadPullRequests,
} from "@t3tools/shared/threadPullRequests";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as Orchestrator from "../../../orchestration-v2/Orchestrator.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as PullRequestReviewGuideService from "../../../pullRequest/PullRequestReviewGuideService.ts";
import { pullRequestSyncKey } from "../../../pullRequest/pullRequestSyncKey.ts";
import { postedReviewFindings, readReviewFindings } from "@t3tools/shared/reviewFindings";
import * as ReviewActivityStore from "../../../review/ReviewActivityStoreV2.ts";
import * as ProjectionStore from "../../../orchestration-v2/ProjectionStore.ts";
import * as PullRequestAgentReview from "../../../pullRequest/PullRequestAgentReview.ts";
import * as ReviewFindingsPoster from "../../../review/ReviewFindingsPoster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import {
  type ListThreadPullRequestsResult,
  type PostReviewFindingsInput,
  type SubmitReviewFindingsInput,
  PullRequestReviewFailedError,
  ReviewFindingsFailedError,
  ReviewFindingsTargetMissingError,
  ReviewPostFailedError,
  ReviewPostNotRequestedError,
  ReviewPostNothingError,
  PullRequestLinkFailedError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotOpenError,
  type PullRequestTargetInput,
  PullRequestWatchFailedError,
  PullRequestWatchFromSubagentError,
  PullRequestThreadNotFoundError,
  PullRequestThreadRequiredError,
  PullRequestGuideFailedError,
  PullRequestProjectNotFoundError,
  PullRequestsToolkit,
  type ThreadPullRequestEntry,
} from "./tools.ts";

interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

function projectHostAndProvider(project: OrchestrationProjectShell | undefined): {
  readonly host: string | null;
  readonly kind: SourceControlProviderKind | null;
} {
  const identity = project?.repositoryIdentity;
  const kind = (identity?.provider as SourceControlProviderKind | undefined) ?? null;
  if (!identity || kind === null) return { host: null, kind: null };
  return {
    host: pullRequestHostOf(identity, kind),
    kind,
  };
}

const resolveTarget = Effect.fn("PullRequestsToolkit.resolveTarget")(function* (
  input: PullRequestTargetInput,
  project: OrchestrationProjectShell | undefined,
) {
  if (input.url !== undefined) {
    const parsed = parseChangeRequestUrl(input.url);
    if (parsed === null) {
      return yield* new PullRequestUrlInvalidError({});
    }
    return { ...normalizeThreadPullRequestKey(parsed), url: input.url } satisfies ResolvedTarget;
  }
  if (input.repository === undefined || input.number === undefined) {
    return yield* new PullRequestTargetIncompleteError({});
  }
  const projectHost = projectHostAndProvider(project);
  const host = (input.host ?? projectHost.host)?.toLowerCase();
  if (host === undefined) {
    return yield* new PullRequestHostRequiredError({});
  }
  const repository = input.repository.toLowerCase();
  const url =
    changeRequestUrlFor(
      host === projectHost.host ? projectHost.kind : null,
      host,
      repository,
      input.number,
      project?.repositoryIdentity?.locator.remoteUrl,
    ) ?? `https://${host}/${repository}/pull/${input.number}`;
  return {
    ...normalizeThreadPullRequestKey({ host, repository, number: input.number, url }),
    url,
  } satisfies ResolvedTarget;
});

function entryOf(
  link: ThreadPullRequestLink,
  chains: ReturnType<typeof resolveThreadPullRequestChains>,
): ThreadPullRequestEntry {
  const key = threadPullRequestKeyOf(link);
  let stack: ThreadPullRequestEntry["stack"] = null;
  for (const chain of chains) {
    if (chain.layers.length < 2) continue;
    const index = chain.layers.findIndex((layer) => threadPullRequestKeyOf(layer) === key);
    if (index !== -1) {
      stack = { kind: chain.kind, position: chain.depths[index]! + 1, size: chain.layers.length };
      break;
    }
  }
  return {
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    watching: link.watch !== undefined,
    state: link.snapshot?.state ?? null,
    title: link.snapshot?.title ?? null,
    headBranch: link.snapshot?.headBranch ?? null,
    baseBranch: link.snapshot?.baseBranch ?? null,
    isDraft: link.snapshot?.isDraft ?? null,
    stack,
  };
}

export function listThreadPullRequests(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests">,
): ListThreadPullRequestsResult {
  const chains = resolveThreadPullRequestChains(thread.pullRequests ?? []);
  return {
    pullRequests: visibleThreadPullRequests(thread.pullRequests ?? []).map((link) =>
      entryOf(link, chains),
    ),
    chains: chains.map((chain) => ({
      kind: chain.kind,
      numbers: chain.layers.map((layer) => layer.number),
    })),
  };
}

function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // The same rule the guide service uses: a pull request reads through a project whose checkout
  // names it with the same host-level key, which also maps Azure DevOps' org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    const projectKey =
      project.repositoryIdentity == null
        ? null
        : pullRequestSyncKey(
            {
              projectId: project.id,
              repository: sourceControlRepositorySelector(project.repositoryIdentity) ?? "",
              number: 1,
            },
            project.repositoryIdentity,
          );
    return (
      own !== null &&
      projectKey !== null &&
      own.host === projectKey.host &&
      own.repository === projectKey.repository
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

export function reviewFindingsTarget(
  thread: Pick<OrchestrationV2ThreadShell, "pullRequests">,
  requested: SubmitReviewFindingsInput["target"],
): ReviewFindingsTarget | null {
  if (requested === "local") return { kind: "local" };
  let link: ThreadPullRequestLink | undefined;
  for (const candidate of visibleThreadPullRequests(thread.pullRequests ?? [])) {
    if (link === undefined || candidate.linkedAt > link.linkedAt) link = candidate;
  }
  if (link === undefined) return requested === "pull-request" ? null : { kind: "local" };
  return { kind: "pull-request", ...normalizeThreadPullRequestKey(link), url: link.url };
}

const decodeReviewStarted = Schema.decodeUnknownOption(ReviewStartedActivityPayload);

/** How many other threads on the same pull request are searched for findings to post. */
const POST_FINDINGS_LINKED_THREADS = 5;

/**
 * The findings a `post_review_findings` call asked for, by their card keys, without those already
 * posted. Exported so the choice is testable without a layer.
 */
export function selectFindingsToPost(
  payload: {
    readonly findings: ReadonlyArray<ReviewFinding>;
    readonly needsChecking: ReadonlyArray<ReviewFinding>;
  },
  request: Pick<PostReviewFindingsInput, "keys" | "severities">,
  posted: ReadonlySet<string>,
):
  | {
      readonly selected: ReadonlyArray<{ readonly key: string; readonly finding: ReviewFinding }>;
      readonly alreadyPosted: number;
    }
  | ReviewPostNothingError["reason"] {
  const reported = payload.findings.map((finding, index) => ({ key: `finding:${index}`, finding }));
  const unsettled = payload.needsChecking.map((finding, index) => ({
    key: `check:${index}`,
    finding,
  }));
  let chosen: ReadonlyArray<{ readonly key: string; readonly finding: ReviewFinding }>;
  if (request.keys !== undefined) {
    const byKey = new Map([...reported, ...unsettled].map((entry) => [entry.key, entry]));
    const picked = request.keys.map((key) => byKey.get(key));
    if (picked.some((entry) => entry === undefined)) return "unknown-key";
    chosen = [...new Set(picked as ReadonlyArray<{ key: string; finding: ReviewFinding }>)];
  } else {
    // Unsettled findings go only when named: nobody confirmed them.
    const severities = request.severities;
    chosen =
      severities === undefined
        ? reported
        : reported.filter((entry) => severities.includes(entry.finding.severity));
  }
  if (chosen.length === 0) return "none-selected";
  const selected = chosen.filter((entry) => !posted.has(entry.key));
  if (selected.length === 0) return "already-posted";
  return { selected, alreadyPosted: chosen.length - selected.length };
}

const VERDICT_LABELS: Record<ReviewFindingsActivityPayload["verdict"], string> = {
  approve: "approve",
  "approve-with-nits": "approve with nits",
  "request-changes": "request changes",
};

/**
 * `submit_review_findings`: records a review's findings on the credential's own thread. Also run
 * by `POST /api/review-findings` for the `viewcode-review` CLI, which reviewers use when MCP is
 * blocked, so both transports share one gate and one record.
 */
export const makeSubmitReviewFindings = Effect.gen(function* () {
  const activities = yield* ReviewActivityStore.ReviewActivityStoreV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const crypto = yield* Crypto.Crypto;
  const reviews = yield* PullRequestAgentReview.PullRequestAgentReview;

  /** What the server recorded when it started the review in this thread; empty when it did not. */
  const reviewStart = (threadId: ThreadId) =>
    activities.list(threadId, [REVIEW_STARTED_ACTIVITY_KIND]).pipe(
      Effect.map((records): ReviewStartedActivityPayload => {
        const latest = records.at(-1);
        return latest === undefined
          ? {}
          : Option.getOrElse(decodeReviewStarted(latest.payload), () => ({}));
      }),
      Effect.orElseSucceed((): ReviewStartedActivityPayload => ({})),
    );

  return Effect.fn("PullRequestsToolkit.submitReviewFindings")(function* ({
    target: requested,
    mode: requestedMode,
    previous,
    complete,
    ...report
  }: SubmitReviewFindingsInput) {
    const capability = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const scope = yield* McpInvocationContext.requireThreadScope(
      capability,
      "Submitting review findings",
    );
    const found = yield* projections
      .getThreadShell(scope.thread.threadId)
      .pipe(Effect.map(Option.fromNullishOr))
      .pipe(Effect.mapError((cause) => new ReviewFindingsFailedError({ cause })));
    if (Option.isNone(found)) {
      return yield* new PullRequestThreadNotFoundError({ threadId: scope.thread.threadId });
    }
    const thread = found.value;
    const target = reviewFindingsTarget(thread, requested);
    if (target === null) return yield* new ReviewFindingsTargetMissingError({});
    // Local changes have nowhere to post to.
    const mode: ReviewFindingsMode =
      target.kind === "local"
        ? "fix"
        : (requestedMode ??
          PullRequestAgentReview.reviewFindingsModeFor(
            yield* reviews.authorship({
              projectId: thread.projectId,
              host: target.host,
              repository: target.repository,
              number: target.number,
            }),
          ));
    const started = yield* reviewStart(thread.id);
    const payload: ReviewFindingsActivityPayload = {
      ...report,
      target,
      mode,
      // The commit the start asked for; the reviewer was told to review it even if the pull
      // request moved on, so posting pins its comments there.
      ...(target.kind === "pull-request" && started.headSha !== undefined
        ? { headSha: started.headSha }
        : {}),
      // A re-review says which findings it started from, so clients can tell it apart.
      ...(started.incremental === true && started.basedOn !== undefined
        ? { incremental: true, basedOn: started.basedOn }
        : {}),
      ...(previous === undefined ? {} : { previous }),
      // A set sent while the review goes on, which a later call replaces.
      complete: complete ?? true,
    };
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const count = report.findings.length;
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    // Clients show only the latest findings activity, which is how a re-review replaces the
    // set. It belongs to the running turn, so reverting that turn removes it.
    yield* activities
      .append({
        commandId: CommandId.make(`server:mcp-review-findings:${thread.id}:${uuid}`),
        threadId: thread.id,
        activity: {
          id: EventId.make(yield* crypto.randomUUIDv4().pipe(Effect.orDie)),
          tone: "info",
          kind: REVIEW_FINDINGS_ACTIVITY_KIND,
          summary: `${complete === false ? "Review so far" : "Review"}: ${VERDICT_LABELS[report.verdict]}, ${count} ${count === 1 ? "finding" : "findings"}`,
          payload,
          turnId: thread.activeRunId === null ? null : TurnId.make(thread.activeRunId),
          createdAt,
        },
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause as Cause.Cause<never>)
            : Effect.fail(new ReviewFindingsFailedError({ cause })),
        ),
      );
    return {
      target: target.kind,
      findings: count,
      needsChecking: report.needsChecking.length,
      message:
        complete === false
          ? "Recorded and shown to the reader as the findings so far. Keep reviewing; each later call passes the whole set so far, and the last one, after your report, leaves out complete."
          : "Recorded and shown to the reader under your report. Don't repeat the findings; end your turn.",
    };
  });
});

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const reviewGuides = yield* PullRequestReviewGuideService.PullRequestReviewGuideService;

  const projects = yield* ProjectService.ProjectService;
  const crypto = yield* Crypto.Crypto;

  const reviews = yield* PullRequestAgentReview.PullRequestAgentReview;
  const poster = yield* ReviewFindingsPoster.ReviewFindingsPoster;
  const activities = yield* ReviewActivityStore.ReviewActivityStoreV2;
  const submitReviewFindings = yield* makeSubmitReviewFindings;
  const reviewActivities = (threadId: ThreadId) =>
    activities
      .list(threadId, [REVIEW_FINDINGS_ACTIVITY_KIND, REVIEW_FINDINGS_POSTED_ACTIVITY_KIND])
      .pipe(Effect.mapError((cause) => new ReviewPostFailedError({ cause })));

  /**
   * The findings to post from: the one asked for, else the latest on this thread, else the latest
   * on another thread linked to the same pull request (a review thread, from a thread that works
   * on the pull request).
   */
  const findFindingsToPost = Effect.fn("PullRequestsToolkit.findFindingsToPost")(function* (
    thread: OrchestrationV2ThreadShell,
    requestedId: string | undefined,
  ) {
    const pick = (activities: ReadonlyArray<OrchestrationThreadActivity>) =>
      requestedId === undefined
        ? activities.findLast((activity) => activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND)
        : activities.find(
            (activity) =>
              activity.id === requestedId && activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND,
          );
    const own = yield* reviewActivities(thread.id);
    const found = pick(own);
    if (found !== undefined) return { threadId: thread.id, activity: found, activities: own };
    const keys = new Set(
      visibleThreadPullRequests(thread.pullRequests ?? []).map(threadPullRequestKeyOf),
    );
    if (keys.size === 0) return undefined;
    const linked = (yield* engine
      .getShellSnapshot()
      .pipe(Effect.map((snapshot) => snapshot.threads))
      .pipe(Effect.mapError((cause) => new ReviewPostFailedError({ cause }))))
      .filter(
        (other) =>
          other.id !== thread.id &&
          visibleThreadPullRequests(other.pullRequests ?? []).some((link) =>
            keys.has(threadPullRequestKeyOf(link)),
          ),
      )
      .slice(-POST_FINDINGS_LINKED_THREADS);
    let latest:
      | {
          readonly threadId: ThreadId;
          readonly activity: OrchestrationThreadActivity;
          readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
        }
      | undefined;
    for (const other of linked) {
      const activities = yield* reviewActivities(other.id);
      const candidate = pick(activities);
      if (
        candidate !== undefined &&
        (latest === undefined || candidate.createdAt > latest.activity.createdAt)
      ) {
        latest = { threadId: other.id, activity: candidate, activities };
      }
    }
    return latest;
  });

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) => CommandId.make(`server:${tag}:${threadId}:${uuid}`)),
    );

  const requireThread = Effect.fn("PullRequestsToolkit.requireThread")(function* (
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestListFailedError
      | typeof PullRequestWatchFailedError
      | typeof PullRequestReviewFailedError
      | typeof ReviewPostFailedError
      | typeof ReviewFindingsFailedError,
    requested: ThreadId | undefined = undefined,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const threadId = requested ?? scope.thread?.threadId;
    if (threadId === undefined) {
      return yield* new PullRequestThreadRequiredError();
    }
    const thread = yield* engine
      .getThreadShell(threadId)
      .pipe(Effect.map(Option.fromNullishOr))
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(thread) || thread.value.deletedAt !== null) {
      return yield* new PullRequestThreadNotFoundError({ threadId });
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationV2ThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestWatchFailedError
      | typeof PullRequestReviewFailedError,
  ) =>
    projects.getShell(thread.projectId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.mapError((cause) => new Failure({ cause })),
    );

  const dispatchFailure =
    (
      Failure:
        | typeof PullRequestLinkFailedError
        | typeof PullRequestUnlinkFailedError
        | typeof PullRequestWatchFailedError,
    ) =>
    <E>(
      cause: Cause.Cause<E>,
    ): Effect.Effect<
      never,
      PullRequestLinkFailedError | PullRequestUnlinkFailedError | PullRequestWatchFailedError
    > =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.failCause(cause as Cause.Cause<never>)
        : Effect.fail(new Failure({ cause }));

  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireThread(PullRequestWatchFailedError, input.threadId);
    const project = yield* projectOf(thread, PullRequestWatchFailedError);
    const target = yield* resolveTarget(input, project);
    const watchedLink = (shell: OrchestrationV2ThreadShell) =>
      threadPullRequestsOf(shell).find(
        (link) => link.source !== "stack-dismissed" && threadPullRequestKeysEqual(link, target),
      );
    if (watching && thread.lineage.relationshipToParent === "subagent") {
      return yield* new PullRequestWatchFromSubagentError();
    }
    const before = watchedLink(thread);
    if (watching && before?.snapshot?.state === "merged") {
      return yield* new PullRequestNotOpenError({ state: "merged" });
    }
    yield* engine
      .dispatch({
        type: "thread.pull-request.watch",
        commandId: yield* commandId("mcp-pr-watch", thread.id),
        threadId: thread.id,
        host: target.host,
        repository: target.repository,
        number: target.number,
        watching,
        ...(watching ? { link: { url: target.url, source: "agent" as const } } : {}),
      })
      .pipe(Effect.catchCause(dispatchFailure(PullRequestWatchFailedError)));
    const after = yield* requireThread(PullRequestWatchFailedError, thread.id);
    return {
      host: target.host,
      repository: target.repository,
      number: target.number,
      url: target.url,
      watching: watchedLink(after)?.watch !== undefined,
      wasWatching: before?.watch !== undefined,
    };
  });

  const locateAll = Effect.fn("PullRequestsToolkit.locateAll")(function* (
    targets: ReadonlyArray<Omit<PullRequestTargetInput, "threadId">>,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const callerThread =
      scope.thread === undefined
        ? undefined
        : yield* engine.getThreadShell(scope.thread.threadId).pipe(
            Effect.orElseSucceed(() => null),
            Effect.map((shell) => shell ?? undefined),
          );
    const known = yield* projects
      .listShells()
      .pipe(Effect.mapError((cause) => new PullRequestListFailedError({ cause })));
    const callerProject = known.find((project) => project.id === callerThread?.projectId);
    return yield* Effect.forEach(targets, (input) =>
      resolveTarget(input, callerProject).pipe(
        Effect.map((target) => ({
          input,
          target,
          project: projectForPullRequest(known, target, callerProject),
          failure: null,
        })),
        Effect.catch((error) =>
          Effect.succeed({ input, target: null, project: undefined, failure: error.message }),
        ),
      ),
    );
  });

  const guideReference = (
    project: OrchestrationProjectShell,
    target: { readonly host: string; readonly repository: string; readonly number: number },
  ) => ({
    projectId: project.id,
    host: target.host,
    repository: target.repository,
    number: target.number,
  });

  const guideFailureDetail = (error: { readonly message: string }) =>
    "detail" in error && typeof error.detail === "string" ? error.detail : error.message;

  const writesThread = <P extends { readonly threadId?: ThreadId | undefined }, A, E, R>(
    handle: (params: P) => Effect.Effect<A, E, R>,
  ) => McpToolAccess.writesThreads((params: P) => [params.threadId], handle);

  return {
    link_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
        const existing = threadPullRequestsOf(thread).find((link) =>
          threadPullRequestKeysEqual(link, target),
        );
        if (existing && existing.source !== "stack-dismissed")
          return { ...target, alreadyLinked: true };
        const alreadyLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.link",
            commandId: yield* commandId("mcp-pr-link", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
            url: target.url,
            source: "agent",
          })
          .pipe(
            Effect.as(false),

            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked };
      }),
    ),
    unlink_pull_request: writesThread((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError, input.threadId);
        const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
        const target = yield* resolveTarget(input, project);
        if (!threadPullRequestsOf(thread).some((link) => threadPullRequestKeysEqual(link, target)))
          return {
            host: target.host,
            repository: target.repository,
            number: target.number,
            wasLinked: false,
          };
        const wasLinked = yield* engine
          .dispatch({
            type: "thread.pull-request.unlink",
            commandId: yield* commandId("mcp-pr-unlink", thread.id),
            threadId: thread.id,
            host: target.host,
            repository: target.repository,
            number: target.number,
          })
          .pipe(
            Effect.as(true),

            Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError)),
          );
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked,
        };
      }),
    ),
    list_thread_pull_requests: McpToolAccess.reads((input) =>
      requireThread(PullRequestListFailedError, input.threadId).pipe(
        Effect.map(listThreadPullRequests),
      ),
    ),
    watch_pull_request: writesThread((input) => setWatching(input, true)),
    unwatch_pull_request: writesThread((input) => setWatching(input, false)),
    write_pull_request_guides: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const located = yield* locateAll(input.pullRequests);
        const guides = yield* Effect.forEach(
          located,
          (entry) =>
            Effect.gen(function* () {
              if (entry.target === null) {
                return {
                  host: entry.input.host ?? "",
                  repository: entry.input.repository ?? "",
                  number: entry.input.number ?? 0,
                  url: entry.input.url ?? "",
                  outcome: "failed" as const,
                  detail: entry.failure,
                };
              }
              const identity = {
                host: entry.target.host,
                repository: entry.target.repository,
                number: entry.target.number,
                url: entry.target.url,
              };
              if (entry.project === undefined) {
                return {
                  ...identity,
                  outcome: "failed" as const,
                  detail: new PullRequestProjectNotFoundError({
                    repository: entry.target.repository,
                  }).message,
                };
              }
              return yield* reviewGuides.generate(guideReference(entry.project, entry.target)).pipe(
                Effect.map((result) => ({
                  ...identity,
                  outcome: result.started ? ("started" as const) : ("running" as const),
                  detail: null,
                })),
                Effect.catch((error) =>
                  Effect.succeed({
                    ...identity,
                    outcome: "failed" as const,
                    detail: guideFailureDetail(error),
                  }),
                ),
              );
            }),
          { concurrency: 4 },
        );
        return { guides };
      }),
    ),
    read_pull_request_guide: McpToolAccess.reads((input) =>
      Effect.gen(function* () {
        const [entry] = yield* locateAll([input]);
        if (entry !== undefined && entry.target === null) {
          return yield* new PullRequestGuideFailedError({ detail: entry.failure ?? "" });
        }
        if (entry === undefined || entry.target === null || entry.project === undefined) {
          return yield* new PullRequestProjectNotFoundError({
            repository: entry?.target.repository ?? input.repository ?? "",
          });
        }
        const result = yield* reviewGuides.get(guideReference(entry.project, entry.target)).pipe(
          Effect.mapError(
            (error) =>
              new PullRequestGuideFailedError({
                detail: guideFailureDetail(error),
                cause: error,
              }),
          ),
        );
        return {
          host: entry.target.host,
          repository: entry.target.repository,
          number: entry.target.number,
          url: entry.target.url,
          guide: result.guide,
          run: result.run,
          currentHeadSha: result.currentHeadSha,
          stale:
            result.guide !== null &&
            result.currentHeadSha !== null &&
            result.guide.headSha !== result.currentHeadSha,
        };
      }),
    ),
    submit_review_findings: McpToolAccess.readsAsCaller(submitReviewFindings),
    post_review_findings: McpToolAccess.writesWithCapability((input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(ReviewPostFailedError);
        // Only a turn the user started with their own message may post under their name.
        const records = yield* engine
          .getThreadRecords(thread.id, ["messages"])
          .pipe(Effect.mapError((cause) => new ReviewPostFailedError({ cause })));
        const askedByUser =
          thread.activeRunId !== null &&
          records.messages.some(
            (message) =>
              message.runId === thread.activeRunId &&
              message.role === "user" &&
              message.createdBy === "user" &&
              message.scheduledTaskId === undefined &&
              message.senderThreadId === undefined,
          );
        if (!askedByUser) return yield* new ReviewPostNotRequestedError({});

        const source = yield* findFindingsToPost(thread, input.findingsActivityId);
        const payload = source === undefined ? undefined : readReviewFindings(source.activity);
        if (source === undefined || payload === undefined) {
          return yield* new ReviewPostNothingError({ reason: "no-findings" });
        }
        if (payload.target.kind !== "pull-request") {
          return yield* new ReviewPostNothingError({ reason: "local" });
        }
        const posted = postedReviewFindings(source.activities, source.activity.id);
        const selection = selectFindingsToPost(payload, input, new Set(posted.keys()));
        if (typeof selection === "string") {
          return yield* new ReviewPostNothingError({ reason: selection });
        }
        const result = yield* poster.post({
          reviewThreadId: source.threadId,
          findingsActivityId: source.activity.id,
          target: payload.target,
          verdict: input.verdict ?? "comment",
          overallComment: input.overallComment ?? "",
          findings: selection.selected,
        });
        const inline = result.findings.filter((entry) => entry.placement === "inline").length;
        return {
          url: result.url,
          posted: result.findings.length,
          inline,
          inText: result.findings.length - inline,
          alreadyPosted: selection.alreadyPosted,
          headMoved: result.headMoved ?? false,
        };
      }),
    ),
    review_local_changes: McpToolAccess.writesWithCapability(({ mode, focus, scope }) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestReviewFailedError);
        return yield* reviews.startLocal({
          projectId: thread.projectId,
          sourceThreadId: thread.id,
          mode,
          focus,
          scope,
          fallbackModelSelection: thread.modelSelection,
        });
      }),
    ),
    review_pull_request: McpToolAccess.writesWithCapability(
      ({ mode, focus, findingsMode, ...targetInput }) =>
        Effect.gen(function* () {
          const thread = yield* requireThread(PullRequestReviewFailedError);
          const project = yield* projectOf(thread, PullRequestReviewFailedError);
          const target = yield* resolveTarget(targetInput, project);
          const started = yield* reviews.start({
            reference: {
              projectId: thread.projectId,
              host: target.host,
              repository: target.repository,
              number: target.number,
            },
            mode,
            focus,
            findingsMode,
            // A user who never set a default model gets a reviewer like the agent that asked.
            fallbackModelSelection: thread.modelSelection,
            linkSource: "agent",
            sourceThreadId: thread.id,
          });
          return { ...target, threadId: started.threadId, title: started.title };
        }),
    ),
  } satisfies McpToolAccess.Handlers<typeof PullRequestsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(PullRequestsToolkit, make);
