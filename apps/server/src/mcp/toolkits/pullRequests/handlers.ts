import {
  CommandId,
  EventId,
  pullRequestHostOf,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  REVIEW_STARTED_ACTIVITY_KIND,
  ReviewStartedActivityPayload,
  type OrchestrationProjectShell,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  type ReviewFinding,
  type ReviewFindingsActivityPayload,
  type ReviewFindingsMode,
  type ReviewFindingsTarget,
  type SourceControlProviderKind,
  type ThreadId,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import { changeRequestUrlFor, parseChangeRequestUrl } from "@t3tools/shared/changeRequestUrl";
import { postedReviewFindings, readReviewFindings } from "@t3tools/shared/reviewFindings";
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

import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TurnOrigin from "../../../orchestration/TurnOrigin.ts";
import * as PullRequestAgentReview from "../../../pullRequest/PullRequestAgentReview.ts";
import * as ReviewFindingsPoster from "../../../review/ReviewFindingsPoster.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  type ListThreadPullRequestsResult,
  type PostReviewFindingsInput,
  ReviewPostFailedError,
  ReviewPostNotRequestedError,
  ReviewPostNothingError,
  PullRequestLinkFailedError,
  PullRequestUrlInvalidError,
  PullRequestTargetIncompleteError,
  PullRequestHostRequiredError,
  PullRequestUnlinkFailedError,
  PullRequestListFailedError,
  PullRequestNotWatchableError,
  PullRequestReviewFailedError,
  type PullRequestTargetInput,
  PullRequestWatchFailedError,
  PullRequestThreadNotFoundError,
  PullRequestsToolkit,
  ReviewFindingsFailedError,
  ReviewFindingsTargetMissingError,
  type SubmitReviewFindingsInput,
  type ThreadPullRequestEntry,
} from "./tools.ts";

interface ResolvedTarget {
  readonly host: string;
  readonly repository: string;
  readonly number: number;
  readonly url: string;
}

/** The project's host and provider supply defaults for a repository-and-number input. */
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

/**
 * Turns whichever shape the agent passed into one host-level identity. A URL
 * wins outright; otherwise the repository and number are completed with the
 * thread's project host, which is where an agent working in that checkout
 * almost always opened the pull request.
 */
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
      // The project's kind only describes its own host; another host gets no URL guess.
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
      stack = { kind: chain.kind, position: index + 1, size: chain.layers.length };
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

/** What the tools report from a thread shell; exported so the shape is testable without a layer. */
export function listThreadPullRequests(
  thread: Pick<OrchestrationThreadShell, "pullRequests">,
): ListThreadPullRequestsResult {
  const chains = resolveThreadPullRequestChains(thread.pullRequests);
  return {
    pullRequests: visibleThreadPullRequests(thread.pullRequests).map((link) =>
      entryOf(link, chains),
    ),
    chains: chains.map((chain) => ({
      kind: chain.kind,
      numbers: chain.layers.map((layer) => layer.number),
    })),
  };
}

/**
 * What a review recorded with `submit_review_findings` was about: the pull request linked to the
 * thread most recently (a review thread has one), or the thread's own checkout. Null when the
 * reviewer asked for a pull request and none is linked.
 */
export function reviewFindingsTarget(
  thread: Pick<OrchestrationThreadShell, "pullRequests">,
  requested: SubmitReviewFindingsInput["target"],
): ReviewFindingsTarget | null {
  if (requested === "local") return { kind: "local" };
  let link: ThreadPullRequestLink | undefined;
  for (const candidate of visibleThreadPullRequests(thread.pullRequests)) {
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

const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;
  const reviews = yield* PullRequestAgentReview.PullRequestAgentReview;
  const poster = yield* ReviewFindingsPoster.ReviewFindingsPoster;
  const turnOrigin = yield* TurnOrigin.TurnOrigin;

  const reviewActivities = (threadId: ThreadId) =>
    snapshots
      .getThreadDetailById(threadId, {
        activityKinds: [REVIEW_FINDINGS_ACTIVITY_KIND, REVIEW_FINDINGS_POSTED_ACTIVITY_KIND],
      })
      .pipe(
        Effect.map((thread) => Option.getOrUndefined(thread)?.activities ?? []),
        Effect.mapError((cause) => new ReviewPostFailedError({ cause })),
      );

  /**
   * The findings to post from: the one asked for, else the latest on this thread, else the latest
   * on another thread linked to the same pull request (a review thread, from a thread that works
   * on the pull request).
   */
  const findFindingsToPost = Effect.fn("PullRequestsToolkit.findFindingsToPost")(function* (
    thread: OrchestrationThreadShell,
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
      visibleThreadPullRequests(thread.pullRequests).map(threadPullRequestKeyOf),
    );
    if (keys.size === 0) return undefined;
    const linked = (yield* snapshots
      .listThreadsWithPullRequests()
      .pipe(Effect.mapError((cause) => new ReviewPostFailedError({ cause }))))
      .filter(
        (other) =>
          other.id !== thread.id &&
          visibleThreadPullRequests(other.pullRequests).some((link) =>
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

  /** What the server recorded when it started the review in this thread; empty when it did not. */
  const reviewStart = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId, { activityKinds: [REVIEW_STARTED_ACTIVITY_KIND] }).pipe(
      Effect.map((thread): ReviewStartedActivityPayload => {
        const latest = Option.getOrUndefined(thread)?.activities.at(-1);
        return latest === undefined
          ? {}
          : Option.getOrElse(decodeReviewStarted(latest.payload), () => ({}));
      }),
      Effect.orElseSucceed((): ReviewStartedActivityPayload => ({})),
    );

  const commandId = (tag: string, threadId: ThreadId) =>
    crypto.randomUUIDv4.pipe(
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
      | typeof ReviewFindingsFailedError
      | typeof ReviewPostFailedError,
  ) {
    const scope = yield* McpInvocationContext.requireMcpCapability("pull-requests");
    const thread = yield* snapshots
      .getThreadShellById(scope.threadId)
      .pipe(Effect.mapError((cause) => new Failure({ cause })));
    if (Option.isNone(thread)) {
      return yield* new PullRequestThreadNotFoundError({ threadId: scope.threadId });
    }
    return thread.value;
  });

  const projectOf = (
    thread: OrchestrationThreadShell,
    Failure:
      | typeof PullRequestLinkFailedError
      | typeof PullRequestUnlinkFailedError
      | typeof PullRequestWatchFailedError
      | typeof PullRequestReviewFailedError,
  ) =>
    snapshots.getProjectShellById(thread.projectId).pipe(
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

  /**
   * Starts or stops a watch. One command links an unlinked pull request and watches it; asking
   * for the state the thread already holds succeeds without a command.
   */
  const setWatching = Effect.fn("PullRequestsToolkit.setWatching")(function* (
    input: PullRequestTargetInput,
    watching: boolean,
  ) {
    const thread = yield* requireThread(PullRequestWatchFailedError);
    const project = yield* projectOf(thread, PullRequestWatchFailedError);
    const target = yield* resolveTarget(input, project);
    const linked = visibleThreadPullRequests(thread.pullRequests).find(
      (link) => threadPullRequestKeyOf(link) === threadPullRequestKeyOf(target),
    );
    const wasWatching = linked?.watch !== undefined;
    const result = {
      host: target.host,
      repository: target.repository,
      number: target.number,
      url: target.url,
      wasWatching,
    };
    if (wasWatching === watching) return { ...result, watching };
    const refused = yield* engine
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
      .pipe(
        Effect.as(null),
        // The decider says why it refused (merged, closed, settled thread); pass that on.
        Effect.catchTags({
          OrchestrationCommandInvariantError: (error) => Effect.succeed(error.detail),
        }),
        Effect.catchCause(dispatchFailure(PullRequestWatchFailedError)),
      );
    if (refused !== null) return yield* new PullRequestNotWatchableError({ reason: refused });
    return { ...result, watching };
  });

  return PullRequestsToolkit.of({
    link_pull_request: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestLinkFailedError);
        const project = yield* projectOf(thread, PullRequestLinkFailedError);
        const target = yield* resolveTarget(input, project);
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
            // The decider rejects a second link of the same PR; for the agent that is
            // the outcome it asked for, not an error.
            Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.succeed(true) }),
            Effect.catchCause(dispatchFailure(PullRequestLinkFailedError)),
          );
        return { ...target, alreadyLinked };
      }),
    unlink_pull_request: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(PullRequestUnlinkFailedError);
        const project = yield* projectOf(thread, PullRequestUnlinkFailedError);
        const target = yield* resolveTarget(input, project);
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
            Effect.catchTags({ OrchestrationCommandInvariantError: () => Effect.succeed(false) }),
            Effect.catchCause(dispatchFailure(PullRequestUnlinkFailedError)),
          );
        return {
          host: target.host,
          repository: target.repository,
          number: target.number,
          wasLinked,
        };
      }),
    list_thread_pull_requests: () =>
      requireThread(PullRequestListFailedError).pipe(Effect.map(listThreadPullRequests)),
    watch_pull_request: (input) => setWatching(input, true),
    unwatch_pull_request: (input) => setWatching(input, false),
    submit_review_findings: ({
      target: requested,
      mode: requestedMode,
      previous,
      complete,
      ...report
    }) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(ReviewFindingsFailedError);
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
        // Clients show only the latest findings activity, which is how a re-review replaces the
        // set. It belongs to the running turn, so reverting that turn removes it.
        yield* engine
          .dispatch({
            type: "thread.activity.append",
            commandId: yield* commandId("mcp-review-findings", thread.id),
            threadId: thread.id,
            activity: {
              id: EventId.make(yield* crypto.randomUUIDv4.pipe(Effect.orDie)),
              tone: "info",
              kind: REVIEW_FINDINGS_ACTIVITY_KIND,
              summary: `${complete === false ? "Review so far" : "Review"}: ${VERDICT_LABELS[report.verdict]}, ${count} ${count === 1 ? "finding" : "findings"}`,
              payload,
              turnId: thread.session?.activeTurnId ?? null,
              createdAt,
            },
            createdAt,
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
      }),
    post_review_findings: (input) =>
      Effect.gen(function* () {
        const thread = yield* requireThread(ReviewPostFailedError);
        // Only a turn the user started with their own message may post under their name.
        const turnId = thread.session?.activeTurnId ?? null;
        const askedByUser =
          turnId !== null && (yield* turnOrigin.startedByUser({ threadId: thread.id, turnId }));
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
    review_local_changes: ({ mode, focus, scope }) =>
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
    review_pull_request: ({ mode, focus, findingsMode, ...targetInput }) =>
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
  });
});

export const PullRequestsToolkitHandlersLive = PullRequestsToolkit.toLayer(make);
