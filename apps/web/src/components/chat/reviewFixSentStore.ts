import type { ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

export interface ReviewFixDestination {
  readonly threadId: ThreadId;
  readonly title: string;
}

interface ReviewFixSentState {
  /** By findings card (`environmentId:activityId`), then by finding key. */
  readonly sentByCard: Readonly<Record<string, Readonly<Record<string, ReviewFixDestination>>>>;
  readonly markSent: (
    cardKey: string,
    findingKeys: ReadonlyArray<string>,
    destination: ReviewFixDestination,
  ) => void;
}

/**
 * Where each finding was sent to be fixed, so a card can say so and nobody sends one twice by
 * accident. In memory: the timeline unmounts rows it scrolls past, which would lose a card's own
 * state, while a reload forgetting it costs only the reminder.
 */
export const useReviewFixSentStore = create<ReviewFixSentState>()((set) => ({
  sentByCard: {},
  markSent: (cardKey, findingKeys, destination) =>
    set((state) => {
      const card = { ...state.sentByCard[cardKey] };
      for (const key of findingKeys) card[key] = destination;
      return { sentByCard: { ...state.sentByCard, [cardKey]: card } };
    }),
}));
