import { useAtomValue } from "@effect/atom-react";
import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import type {
  OrchestrationThreadActivity,
  ProjectId,
  ScopedThreadRef,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import { Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { useThreadShell, useThreadShells } from "../../state/entities";
import { environmentThreadDetails } from "../../state/threads";
import {
  latestReviewFindingsActivity,
  reviewSourceCandidates,
  type ReviewFindingsSource,
  selectReviewFindingsSource,
} from "./reviewPanel.logic";

type LatestFindings = ReadonlyArray<OrchestrationThreadActivity | undefined>;

const NO_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = [];
const NO_LATEST_FINDINGS: LatestFindings = [];
const NO_LATEST_FINDINGS_ATOM = Atom.make(NO_LATEST_FINDINGS).pipe(
  Atom.withLabel("web-review-latest-findings:empty"),
);

/**
 * Each listed thread's latest findings activity. Reading a thread's activities subscribes to it,
 * so this only lives while a Review panel needs it; and it settles on the same array until one of
 * those activities changes, so a linked thread's ordinary work does not re-render the panel.
 */
const latestFindingsAtomFamily = Atom.family((keys: string) => {
  const refs = keys.split("\n").flatMap((key) => parseScopedThreadKey(key) ?? []);
  let previous: LatestFindings = NO_LATEST_FINDINGS;
  return Atom.make((get) => {
    const next = refs.map((ref) =>
      latestReviewFindingsActivity(get(environmentThreadDetails.activitiesAtom(ref))),
    );
    if (arrayElementsEqual(next, previous)) return previous;
    previous = next;
    return next;
  }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`web-review-latest-findings:${keys}`));
});

/**
 * The findings a thread's Review panel shows (see `selectReviewFindingsSource`) and the pull
 * request a new review of it would look at. Linked threads are only read while the thread has
 * no findings of its own.
 */
export function useReviewFindingsSource(threadRef: ScopedThreadRef): {
  readonly source: ReviewFindingsSource | null;
  readonly pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  readonly projectId: ProjectId | null;
} {
  const shell = useThreadShell(threadRef);
  const activities =
    useAtomValue(environmentThreadDetails.activitiesAtom(threadRef)) ?? NO_ACTIVITIES;
  const shells = useThreadShells();
  const pullRequests = useMemo(
    () => visibleThreadPullRequests(shell?.pullRequests ?? []),
    [shell?.pullRequests],
  );
  const hasOwnFindings = latestReviewFindingsActivity(activities) !== undefined;
  const candidates = useMemo(
    () =>
      hasOwnFindings
        ? []
        : reviewSourceCandidates({
            threadId: threadRef.threadId,
            pullRequests,
            threads: shells.filter((entry) => entry.environmentId === threadRef.environmentId),
          }),
    [hasOwnFindings, pullRequests, shells, threadRef],
  );
  const candidateKeys = candidates
    .map((candidate) => scopedThreadKey(scopeThreadRef(threadRef.environmentId, candidate.id)))
    .join("\n");
  const latestLinked = useAtomValue(
    candidateKeys === "" ? NO_LATEST_FINDINGS_ATOM : latestFindingsAtomFamily(candidateKeys),
  );
  const title = shell?.title ?? "";
  const source = useMemo(
    () =>
      selectReviewFindingsSource({
        thread: { id: threadRef.threadId, title, activities },
        pullRequests,
        linkedThreads: candidates.map((candidate, index) => {
          const latest = latestLinked[index];
          return {
            id: candidate.id,
            title: candidate.title,
            activities: latest === undefined ? NO_ACTIVITIES : [latest],
          };
        }),
      }),
    [activities, candidates, latestLinked, pullRequests, threadRef.threadId, title],
  );
  return { source, pullRequests, projectId: shell?.projectId ?? null };
}
