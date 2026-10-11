import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ReviewFixDestination {
  readonly threadId: ThreadId;
  readonly title: string;
}

/** Which review a card's state belongs to: its thread, whose every set of findings shares it. */
export function reviewFindingsCardKey(environmentId: string, reviewThreadId: string): string {
  return `${environmentId}:${reviewThreadId}`;
}

/** Keyed by review (`reviewFindingsCardKey`), then by finding identity (`reviewFindingIdentity`). */
type ByCard<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

interface ReviewFixSentState {
  readonly sentByCard: ByCard<ReviewFixDestination>;
  /** Findings the reader set aside. */
  readonly dismissedByCard: ByCard<true>;
  readonly markSent: (
    cardKey: string,
    findingKeys: ReadonlyArray<string>,
    destination: ReviewFixDestination,
  ) => void;
  readonly setDismissed: (cardKey: string, findingKey: string, dismissed: boolean) => void;
}

function withEntry<T>(
  byCard: ByCard<T>,
  cardKey: string,
  findingKey: string,
  value: T | undefined,
): ByCard<T> {
  const { [findingKey]: _previous, ...rest } = byCard[cardKey] ?? {};
  return { ...byCard, [cardKey]: value === undefined ? rest : { ...rest, [findingKey]: value } };
}

/**
 * What the reader did with each finding: where it was sent to be fixed, whether they dismissed
 * it. Ratings are the server's, on the review thread. In memory: the panel unmounts with its tab, which would lose its own state, while a
 * reload forgetting it costs only the reminder.
 */
export const useReviewFixSentStore = create<ReviewFixSentState>()((set) => ({
  sentByCard: {},
  dismissedByCard: {},
  markSent: (cardKey, findingKeys, destination) =>
    set((state) => {
      const card = { ...state.sentByCard[cardKey] };
      for (const key of findingKeys) card[key] = destination;
      return { sentByCard: { ...state.sentByCard, [cardKey]: card } };
    }),
  setDismissed: (cardKey, findingKey, dismissed) =>
    set((state) => ({
      dismissedByCard: withEntry(
        state.dismissedByCard,
        cardKey,
        findingKey,
        dismissed ? true : undefined,
      ),
    })),
}));
