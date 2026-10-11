import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ReviewFixDestination {
  readonly threadId: ThreadId;
  readonly title: string;
}

export type ReviewFindingRating = "up" | "down";

/** Keyed by findings set (`environmentId:activityId`), then by finding key. */
type ByCard<T> = Readonly<Record<string, Readonly<Record<string, T>>>>;

interface ReviewFixSentState {
  readonly sentByCard: ByCard<ReviewFixDestination>;
  /** Findings the reader set aside. */
  readonly dismissedByCard: ByCard<true>;
  /** The reader's verdict on a finding. Recorded only; nothing learns from it yet. */
  readonly ratingByCard: ByCard<ReviewFindingRating>;
  readonly markSent: (
    cardKey: string,
    findingKeys: ReadonlyArray<string>,
    destination: ReviewFixDestination,
  ) => void;
  readonly setDismissed: (cardKey: string, findingKey: string, dismissed: boolean) => void;
  /** Rating a finding the way it is already rated clears the rating. */
  readonly rate: (cardKey: string, findingKey: string, rating: ReviewFindingRating) => void;
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
 * What the reader did with each finding: where it was sent to be fixed, whether they dismissed or
 * rated it. In memory: the panel unmounts with its tab, which would lose its own state, while a
 * reload forgetting it costs only the reminder.
 */
export const useReviewFixSentStore = create<ReviewFixSentState>()((set) => ({
  sentByCard: {},
  dismissedByCard: {},
  ratingByCard: {},
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
  rate: (cardKey, findingKey, rating) =>
    set((state) => ({
      ratingByCard: withEntry(
        state.ratingByCard,
        cardKey,
        findingKey,
        state.ratingByCard[cardKey]?.[findingKey] === rating ? undefined : rating,
      ),
    })),
}));
