import { StackActions, type NavigationState } from "@react-navigation/native";

/** The thread a dictation writes into, as the root stack's `Thread` route names it. */
export type VoiceInputThread = {
  readonly environmentId: string;
  readonly threadId: string;
};

/**
 * How the edge dictation pill returns to its thread: back down the root stack
 * when the thread is still under the current screen, otherwise a fresh push.
 * Null when that thread is already the current screen.
 */
export function resolveVoiceInputThreadReturn(
  state: Pick<NavigationState, "index" | "routes"> | undefined,
  thread: VoiceInputThread,
) {
  if (!state) return null;
  for (let index = state.index; index >= 0; index -= 1) {
    const route = state.routes[index];
    const params = route?.params as Partial<VoiceInputThread> | undefined;
    if (
      route?.name === "Thread" &&
      params?.environmentId === thread.environmentId &&
      params.threadId === thread.threadId
    ) {
      return index === state.index ? null : StackActions.pop(state.index - index);
    }
  }
  return StackActions.push("Thread", {
    environmentId: thread.environmentId,
    threadId: thread.threadId,
  });
}
