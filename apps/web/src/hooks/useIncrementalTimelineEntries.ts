import { useState } from "react";
import {
  deriveTimelineEntriesFromVisibleTurnItemsWithState,
  type TimelineEntriesInput,
  type TimelineEntriesProjection,
} from "../session-logic";
const CAPACITY = 3;
function sameInput(left: TimelineEntriesInput, right: TimelineEntriesInput): boolean {
  return (
    left.visibleTurnItems === right.visibleTurnItems &&
    left.optimisticMessages === right.optimisticMessages &&
    left.anchoredMessages === right.anchoredMessages &&
    left.attachmentUrlById === right.attachmentUrlById &&
    left.attempts === right.attempts &&
    left.nodes === right.nodes &&
    left.plans === right.plans
  );
}
export function useIncrementalTimelineEntries(
  threadKey: string | null,
  input: TimelineEntriesInput,
): TimelineEntriesProjection["entries"] {
  const [state, setState] = useState(() => {
    const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input);
    return {
      threadKey,
      projection,
      recent: new Map<string, TimelineEntriesProjection>(
        threadKey === null ? [] : [[threadKey, projection]],
      ),
    };
  });
  if (state.threadKey === threadKey && sameInput(state.projection.input, input))
    return state.projection.entries;
  const previous =
    state.threadKey === threadKey
      ? state.projection
      : threadKey === null
        ? null
        : (state.recent.get(threadKey) ?? null);
  const projection = deriveTimelineEntriesFromVisibleTurnItemsWithState(input, previous);
  const recent = new Map(state.recent);
  if (threadKey !== null) {
    recent.delete(threadKey);
    recent.set(threadKey, projection);
    while (recent.size > CAPACITY) {
      const oldest = recent.keys().next().value;
      if (oldest === undefined) break;
      recent.delete(oldest);
    }
  }
  setState({ threadKey, projection, recent });
  return projection.entries;
}
