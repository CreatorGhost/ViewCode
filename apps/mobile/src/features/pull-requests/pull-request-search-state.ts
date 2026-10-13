export interface PullRequestSearchState {
  readonly query: string;
  readonly searching: boolean;
  readonly scrollOffset: number;
  readonly searchEntryOffset: number;
}

export function initialPullRequestSearchState(): PullRequestSearchState {
  return { query: "", searching: false, scrollOffset: 0, searchEntryOffset: 0 };
}

export type PullRequestSearchAction =
  | { readonly type: "search" }
  | { readonly type: "query"; readonly query: string }
  | { readonly type: "cancel" }
  | { readonly type: "scroll"; readonly offset: number };

/** Cancel returns to the unfiltered list position captured when search opened. */
export function pullRequestSearchReducer(
  state: PullRequestSearchState,
  action: PullRequestSearchAction,
): PullRequestSearchState {
  switch (action.type) {
    case "search":
      return {
        ...state,
        searching: true,
        searchEntryOffset: state.searching ? state.searchEntryOffset : state.scrollOffset,
      };
    case "query":
      return { ...state, query: action.query };
    case "cancel":
      return { ...state, query: "", searching: false, scrollOffset: state.searchEntryOffset };
    case "scroll":
      return state.scrollOffset === action.offset
        ? state
        : { ...state, scrollOffset: action.offset };
  }
}
