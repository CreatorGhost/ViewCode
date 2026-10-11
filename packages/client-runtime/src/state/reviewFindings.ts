import {
  type EnvironmentId,
  type ModelSelection,
  REVIEW_FINDING_RATING_ACTIVITY_KIND,
  REVIEW_FINDINGS_ACTIVITY_KIND,
  REVIEW_FINDINGS_POSTED_ACTIVITY_KIND,
  type OrchestrationThreadActivity,
  type ScopedThreadRef,
  ThreadId,
  type ThreadPullRequestKey,
} from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { scopeThreadRef } from "../environment/scoped.ts";
import { reviewSourceCandidates, reviewTurnInFlight } from "../reviewFindings.ts";
import { arrayElementsEqual } from "./entities.ts";
import type { EnvironmentThreadShell } from "./models.ts";

/** A thread that may hold a review of a pull request, with only what the review selectors read. */
export interface LinkedReviewThread {
  readonly id: ThreadId;
  readonly title: string;
  readonly createdAt: string;
  readonly modelSelection: ModelSelection;
  readonly running: boolean;
  /** Its findings, what was posted from them and how they were rated. */
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
}

export interface LinkedReviewsKey {
  readonly environmentId: EnvironmentId;
  /** The thread asking, which is not one of its own linked threads; null on a pull request page. */
  readonly threadId: ThreadId | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestKey>;
}

const NO_LINKED: ReadonlyArray<LinkedReviewThread> = [];

function isReviewActivity(activity: OrchestrationThreadActivity): boolean {
  return (
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
    left.running === right.running &&
    left.modelSelection.instanceId === right.modelSelection.instanceId &&
    left.modelSelection.model === right.modelSelection.model &&
    arrayElementsEqual(left.activities, right.activities)
  );
}

/**
 * The threads that may hold a review of some pull requests (see `reviewSourceCandidates`), each
 * with its review activities, read through a client's own thread atoms. Reading a thread's
 * activities subscribes to it, so a family member only lives while something on screen reads
 * it; and it settles on the same array until a field the review selectors read changes, so a
 * linked thread's ordinary work does not re-render its readers. Null keys, and keys without pull
 * requests, read nothing.
 */
export function createLinkedReviewThreadsAtomFamily(input: {
  readonly threadShellsAtom: Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>;
  readonly activitiesAtom: (
    ref: ScopedThreadRef,
  ) => Atom.Atom<ReadonlyArray<OrchestrationThreadActivity>>;
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
    let previous: ReadonlyArray<LinkedReviewThread> = NO_LINKED;
    return Atom.make((get) => {
      const candidates = reviewSourceCandidates({
        threadId: threadId === null ? null : ThreadId.make(threadId),
        pullRequests: keys,
        threads: get(input.threadShellsAtom).filter(
          (shell) => shell.environmentId === environmentId,
        ),
      });
      // By id rather than by activity, so two busy threads trading places is not a change.
      const next = [...candidates]
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((shell): LinkedReviewThread => {
          const activities = get(
            input.activitiesAtom(scopeThreadRef(environmentId, shell.id)),
          ).filter(isReviewActivity);
          const linked: LinkedReviewThread = {
            id: shell.id,
            title: shell.title,
            createdAt: shell.createdAt,
            modelSelection: shell.modelSelection,
            running: reviewTurnInFlight(shell),
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
    key === null || key.pullRequests.length === 0
      ? emptyAtom
      : family(
          JSON.stringify([
            key.environmentId,
            key.threadId,
            key.pullRequests.map(({ host, repository, number }) => [host, repository, number]),
          ]),
        );
}
