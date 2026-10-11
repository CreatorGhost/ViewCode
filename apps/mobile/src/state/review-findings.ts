import { useAtomValue } from "@effect/atom-react";
import { createLinkedReviewThreadsAtomFamily } from "@t3tools/client-runtime/state/review-findings";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

/** The threads that may hold a review of some pull requests, with their review activities. */
export const linkedReviewThreadsAtom = createLinkedReviewThreadsAtomFamily({
  threadShellsAtom: environmentThreadShells.threadShellsAtom,
  activitiesAtom: environmentThreadDetails.activitiesAtom,
  label: "mobile-linked-reviews",
});

export interface ReviewFixDestination {
  readonly threadId: ThreadId;
  readonly title: string;
}

/** Which findings set a reader's choices belong to. */
export function reviewFindingsCardKey(environmentId: EnvironmentId, activityId: string): string {
  return `${environmentId}:${activityId}`;
}

/** Keyed by findings set (`reviewFindingsCardKey`), then by finding key. */
type ByCard<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const NO_ENTRIES: Readonly<Record<string, never>> = {};

/**
 * Findings the reader set aside, and where findings were sent to be fixed. Client memory only,
 * like web: forgetting them on restart costs only the reminder, while ratings and posts, which
 * other people see, are the server's.
 */
const dismissedAtom = Atom.make<ByCard<true>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-review-findings:dismissed"),
);

const sentAtom = Atom.make<ByCard<ReviewFixDestination>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-review-findings:sent"),
);

export function useDismissedReviewFindings(cardKey: string): Readonly<Record<string, true>> {
  return useAtomValue(dismissedAtom)[cardKey] ?? NO_ENTRIES;
}

export function useSentReviewFindings(
  cardKey: string,
): Readonly<Record<string, ReviewFixDestination>> {
  return useAtomValue(sentAtom)[cardKey] ?? NO_ENTRIES;
}

export function setReviewFindingDismissed(
  cardKey: string,
  findingKey: string,
  dismissed: boolean,
): void {
  const byCard = appAtomRegistry.get(dismissedAtom);
  const { [findingKey]: _previous, ...rest } = byCard[cardKey] ?? {};
  appAtomRegistry.set(dismissedAtom, {
    ...byCard,
    [cardKey]: dismissed ? { ...rest, [findingKey]: true } : rest,
  });
}

export function markReviewFindingsSent(
  cardKey: string,
  findingKeys: ReadonlyArray<string>,
  destination: ReviewFixDestination,
): void {
  const byCard = appAtomRegistry.get(sentAtom);
  const card = { ...byCard[cardKey] };
  for (const key of findingKeys) card[key] = destination;
  appAtomRegistry.set(sentAtom, { ...byCard, [cardKey]: card });
}
