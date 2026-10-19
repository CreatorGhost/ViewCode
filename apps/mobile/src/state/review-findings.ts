import { useAtomValue } from "@effect/atom-react";
import { createLinkedReviewThreadsAtomFamily } from "@t3tools/client-runtime/state/review-findings";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentAgentControlAtom } from "./agentControl";
import { appAtomRegistry } from "./atom-registry";
import { environmentThreadDetails, environmentThreadShells } from "./threads";

/**
 * The threads that may hold a review a view shows, with their review activities and where their
 * work stands, queued agent messages counted (`agents.control`).
 */
export const linkedReviewThreadsAtom = createLinkedReviewThreadsAtomFamily({
  threadShellsAtom: environmentThreadShells.nativeThreadShellsAtom,
  activitiesAtom: environmentThreadDetails.activitiesAtom,
  agentControlAtom: environmentAgentControlAtom,
  label: "mobile-linked-reviews",
});

export interface ReviewFixDestination {
  readonly threadId: ThreadId;
  readonly title: string;
}

/** Which review a reader's marks belong to: its thread, whose every set of findings shares them. */
export function reviewFindingsCardKey(
  environmentId: EnvironmentId,
  reviewThreadId: string,
): string {
  return `${environmentId}:${reviewThreadId}`;
}

/** Keyed by review (`reviewFindingsCardKey`), then by finding identity (`reviewFindingIdentity`). */
type ByCard<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

const NO_ENTRIES: Readonly<Record<string, never>> = {};

/**
 * Findings the reader set aside, and where findings were sent to be fixed. Client memory only,
 * like web: forgetting them on restart costs only the reminder, while ratings and posts, which
 * other people see, are the server's. Kept by finding identity, so they hold when the review's
 * next set of findings arrives (`reviewFindingMarksByKey` reads them for a set).
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
  identity: string,
  dismissed: boolean,
): void {
  const byCard = appAtomRegistry.get(dismissedAtom);
  const { [identity]: _previous, ...rest } = byCard[cardKey] ?? {};
  appAtomRegistry.set(dismissedAtom, {
    ...byCard,
    [cardKey]: dismissed ? { ...rest, [identity]: true } : rest,
  });
}

export function markReviewFindingsSent(
  cardKey: string,
  identities: ReadonlyArray<string>,
  destination: ReviewFixDestination,
): void {
  const byCard = appAtomRegistry.get(sentAtom);
  const card = { ...byCard[cardKey] };
  for (const identity of identities) card[identity] = destination;
  appAtomRegistry.set(sentAtom, { ...byCard, [cardKey]: card });
}
