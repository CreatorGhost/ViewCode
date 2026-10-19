import {
  type EnvironmentId,
  type ModelSelection,
  REVIEW_FINDING_RATING_ACTIVITY_KIND,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  REVIEW_STARTED_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { scopeThreadShell } from "../viewcodeThread.ts";
import { scopeThreadRef } from "../environment/scoped.ts";
import {
  type ReviewRunState,
  RUNTIME_ERROR_ACTIVITY_KIND,
  reviewRunState,
  reviewRunStatesEqual,
  reviewSourceCandidates,
  startedReviewThreadIds,
  threadReviewCandidates,
} from "../reviewFindings.ts";
import { collectChildAgents } from "./childAgents.ts";
import { arrayElementsEqual } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";

/** A thread that may hold a review, with only what the review selectors read. */
export interface LinkedReviewThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  /** When its latest turn ended; null while it runs or before it ran. */
  readonly endedAt: string | null;
  readonly modelSelection: ModelSelection;
  /** Where its work stands, counting the agents it started (`reviewRunState`). */
  readonly run: ReviewRunState;
  /** A child agent of the thread asking, whose reviews count whatever they reviewed. */
  readonly child: boolean;
  /** How it was started, its findings, what was posted from them and how they were rated. */
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

export interface LinkedReviewsKey {
  readonly environmentId: EnvironmentId;
  /**
   * The thread asking, read itself along with its child agents (`threadReviewCandidates`); null
   * on a pull request page, which reads the threads linked to the pull request.
   */
  readonly threadId: ThreadId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
}

const NO_LINKED: ReadonlyArray<LinkedReviewThread> = [];

function isReviewActivity(activity: OrchestrationThreadActivity): boolean {
  return (
    activity.kind === REVIEW_STARTED_ACTIVITY_KIND ||
    activity.kind === RUNTIME_ERROR_ACTIVITY_KIND ||
    activity.kind === REVIEW_FINDINGS_ACTIVITY_KIND ||
    activity.kind === REVIEW_FINDINGS_POSTED_ACTIVITY_KIND ||
    activity.kind === REVIEW_FINDING_RATING_ACTIVITY_KIND
  );
}

function linkedThreadEqual(left: LinkedReviewThread, right: LinkedReviewThread): boolean {
  return (
    left.id === right.id &&
    left.title === right.title &&
    left.createdAt === right.createdAt &&
    left.endedAt === right.endedAt &&
    left.child === right.child &&
    reviewRunStatesEqual(left.run, right.run) &&
    left.modelSelection.instanceId === right.modelSelection.instanceId &&
    left.modelSelection.model === right.modelSelection.model &&
    arrayElementsEqual(left.activities, right.activities)
  );
}

/**
 * The threads that may hold a review a view shows: for a thread, itself, its child agents and the
 * threads linked to its pull requests (`threadReviewCandidates`); for a pull request page, the
 * threads linked to it (`reviewSourceCandidates`). Each comes with its review activities and where
 * its work stands, read through a client's own thread atoms. Reading a thread's activities
 * subscribes to it, so a family member only lives while something on screen reads it; and it
 * settles on the same array until a field the review selectors read changes, so a linked thread's
 * ordinary work does not re-render its readers. Null keys, and a page key without pull requests,
 * read nothing.
 */
export function createLinkedReviewThreadsAtomFamily(input: {
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly activitiesAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<OrchestrationThreadActivity>>;
  /** Agent messages queued per thread (`agents.control`); without it none count as queued. */
  readonly agentControlAtom?: (
    environmentId: EnvironmentId,
  ) => Atom.Atom<ReadonlyMap<string, { readonly queued: number }>>;
  readonly label: string;
}): (key: LinkedReviewsKey | null) => Atom.Atom<ReadonlyArray<LinkedReviewThread>> {
  const emptyAtom = Atom.make(NO_LINKED).pipe(Atom.withLabel(`${input.label}:empty`));
  const family = Atom.family((serialized: string) => {
    const [environmentId, threadId, pullRequests] = JSON.parse(serialized) as [
      EnvironmentId,
      ThreadId | null,
      ReadonlyArray<[string, string, number]>,
    ];
    const keys = pullRequests.map(([host, repository, number]) => ({ host, repository, number }));
    const asking = threadId === null ? null : ThreadId.make(threadId);
    let previous: ReadonlyArray<LinkedReviewThread> = NO_LINKED;
    return Atom.make((get) => {
      const threads = get(input.threadShellsAtom)
        .filter((shell) => shell.environmentId === environmentId)
        .map((shell) => scopeThreadShell(shell.environmentId, shell.source));
      const control =
        input.agentControlAtom === undefined ? null : get(input.agentControlAtom(environmentId));
      const queued = (threadId: ThreadId) => control?.get(threadId)?.queued ?? 0;
      const candidates =
        asking === null
          ? reviewSourceCandidates({ threadId: null, pullRequests: keys, threads })
          : threadReviewCandidates({
              threadId: asking,
              pullRequests: keys,
              threads,
              reviewThreadIds: startedReviewThreadIds(
                get(input.activitiesAtom(scopeThreadRef(environmentId, asking))),
              ),
            });
      // By id rather than by activity, so two busy threads trading places is not a change.
      const next = [...candidates]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((shell): LinkedReviewThread => {
          const activities = get(
            input.activitiesAtom(scopeThreadRef(environmentId, shell.id)),
          ).filter(isReviewActivity);
          const agents = collectChildAgents(threads, { environmentId, threadId: shell.id }).map(
            (agent) => agent.thread,
          );
          const linked: LinkedReviewThread = {
            id: shell.id,
            title: shell.title,
            createdAt: shell.createdAt,
            endedAt: shell.latestTurn?.completedAt ?? null,
            modelSelection: shell.modelSelection,
            run: reviewRunState(shell, agents, queued),
            child: asking !== null && shell.parentThreadId === asking,
            activities,
          };
          const before = previous.find((entry) => entry.id === shell.id);
          return before !== undefined && linkedThreadEqual(before, linked) ? before : linked;
        });
      if (arrayElementsEqual(next, previous)) return previous;
      previous = next;
      return next;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`${input.label}:${serialized}`));
  });
  return (key) =>
    key === null || (key.threadId === null && key.pullRequests.length === 0)
      ? emptyAtom
      : family(
          JSON.stringify([
            key.environmentId,
            key.threadId,
            key.pullRequests.map(({ host, repository, number }) => [host, repository, number]),
          ]),
        );
}
