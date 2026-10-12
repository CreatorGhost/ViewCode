import {
  StackActions,
  type NavigationAction,
  type NavigationState,
} from "@react-navigation/native";

export interface ThreadRouteParams {
  readonly environmentId: string;
  readonly threadId: string;
}

/**
 * The action that opens another thread from inside a Thread. It pushes, since
 * `navigate` would swap this route's params and Back would skip the parent. A
 * thread already below in the stack is popped back to instead, so moving
 * between a chat and its agents does not pile up history.
 */
export function openThreadFromThreadAction(
  state: Pick<NavigationState, "index" | "routes">,
  params: ThreadRouteParams,
) {
  const matches = (route: NavigationState["routes"][number]) => {
    const routeParams = route.params as Partial<ThreadRouteParams> | undefined;
    return (
      route.name === "Thread" &&
      routeParams?.environmentId === params.environmentId &&
      routeParams?.threadId === params.threadId
    );
  };
  const index = state.routes.findLastIndex(matches);
  if (index === state.index) return null;
  if (index !== -1 && index < state.index) return StackActions.pop(state.index - index);
  return StackActions.push("Thread", { ...params });
}

export function openThreadFromThread(
  navigation: {
    readonly getState: () => Pick<NavigationState, "index" | "routes"> | undefined;
    readonly dispatch: (action: NavigationAction) => void;
  },
  params: ThreadRouteParams,
) {
  const state = navigation.getState();
  const action = state
    ? openThreadFromThreadAction(state, params)
    : StackActions.push("Thread", { ...params });
  if (action) navigation.dispatch(action);
}
