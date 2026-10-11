import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import { appAtomRegistry } from "./atom-registry";

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
 * Findings the reader set aside. Client memory only, like web: forgetting them on restart costs
 * only the reminder, while ratings and posts, which other people see, are the server's.
 */
const dismissedAtom = Atom.make<ByCard<true>>({}).pipe(
  Atom.keepAlive,
  Atom.withLabel("mobile-review-findings:dismissed"),
);

export function useDismissedReviewFindings(cardKey: string): Readonly<Record<string, true>> {
  return useAtomValue(dismissedAtom)[cardKey] ?? NO_ENTRIES;
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
