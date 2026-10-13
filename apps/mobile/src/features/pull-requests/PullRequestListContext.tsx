import {
  createContext,
  use,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  initialPullRequestSearchState,
  pullRequestSearchReducer,
} from "./pull-request-search-state";

interface ScrollAnchor {
  readonly key: string;
  readonly viewOffset: number;
}

function usePullRequestListState() {
  const [state, dispatch] = useReducer(
    pullRequestSearchReducer,
    undefined,
    initialPullRequestSearchState,
  );
  const [environmentId, setEnvironmentId] = useState<string | null>(null);
  const scrollOffset = useRef(0);
  const scrollAnchor = useRef<ScrollAnchor | undefined>(undefined);
  const getScrollOffset = useCallback(() => scrollOffset.current, []);
  const recordScrollOffset = useCallback((offset: number) => {
    scrollOffset.current = offset;
  }, []);
  const getScrollAnchor = useCallback(() => scrollAnchor.current, []);
  const recordScrollAnchor = useCallback((anchor: ScrollAnchor) => {
    scrollAnchor.current = anchor;
  }, []);
  return useMemo(
    () => ({
      state,
      dispatch,
      environmentId,
      setEnvironmentId,
      getScrollOffset,
      recordScrollOffset,
      getScrollAnchor,
      recordScrollAnchor,
    }),
    [
      state,
      environmentId,
      getScrollOffset,
      recordScrollOffset,
      getScrollAnchor,
      recordScrollAnchor,
    ],
  );
}

const PullRequestListContext = createContext<ReturnType<typeof usePullRequestListState> | null>(
  null,
);

export function usePullRequestListContext() {
  return use(PullRequestListContext)!;
}

/** Search and list position belong to the PullRequests route, including while a detail covers it. */
export function PullRequestListProvider(props: { readonly children: ReactNode }) {
  const state = usePullRequestListState();
  return <PullRequestListContext value={state}>{props.children}</PullRequestListContext>;
}
