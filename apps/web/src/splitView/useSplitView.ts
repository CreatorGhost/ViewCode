import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useParams, useRouter } from "@tanstack/react-router";
import { useCallback } from "react";

import { useMediaQuery } from "../hooks/useMediaQuery";
import { useClientSettings } from "../hooks/useSettings";
import { sortThreads } from "../lib/threadSort";
import { readThreadShells } from "../state/entities";
import { buildThreadRouteParams, resolveThreadRouteRef } from "../threadRoutes";
import {
  buildSplitPair,
  pickSplitCompanion,
  resolveFocusedPane,
  SPLIT_MIN_VIEWPORT_WIDTH,
  type SplitPair,
} from "./splitView.logic";
import { useSplitViewStore } from "./splitViewStore";

/** The split on screen right now: the stored pair, if the route is in it and the viewport is wide enough. */
export function useActiveSplit(): { pair: SplitPair; focusedIndex: 0 | 1 } | null {
  const pair = useSplitViewStore((state) => state.pair);
  const wide = useMediaQuery(`(min-width: ${SPLIT_MIN_VIEWPORT_WIDTH}px)`);
  const routeKey = useParams({
    strict: false,
    select: (params) => {
      const ref = resolveThreadRouteRef(params);
      return ref ? scopedThreadKey(ref) : null;
    },
  });
  const focusedIndex = resolveFocusedPane(pair, routeKey);
  return pair && wide && focusedIndex !== null ? { pair, focusedIndex } : null;
}

/** Entry points shared by the sidebar, command palette and keybinding. */
export function useSplitActions() {
  const router = useRouter();
  const sortOrder = useClientSettings((settings) => settings.sidebarThreadSortOrder);

  const currentRef = useCallback((): ScopedThreadRef | null => {
    const match = router.state.matches.at(-1);
    return match ? resolveThreadRouteRef(match.params as Record<string, string>) : null;
  }, [router]);

  /** Show `target` beside the thread on screen; with nothing to pair it opens normally. */
  const openSplitWith = useCallback(
    (target: ScopedThreadRef) => {
      const pair = buildSplitPair(currentRef(), target);
      if (pair) useSplitViewStore.getState().setPair(pair);
      void router.navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams(target),
      });
    },
    [currentRef, router],
  );

  const closeSplit = useCallback(() => useSplitViewStore.getState().close(), []);

  /** Closes an open split, else pairs the current thread with the most recent other one. */
  const toggleSplit = useCallback(() => {
    const store = useSplitViewStore.getState();
    const current = currentRef();
    if (
      store.pair &&
      current &&
      resolveFocusedPane(store.pair, scopedThreadKey(current)) !== null
    ) {
      store.close();
      return;
    }
    const companion = pickSplitCompanion(sortThreads(readThreadShells(), sortOrder), current);
    if (companion && current) {
      store.setPair([current, { environmentId: companion.environmentId, threadId: companion.id }]);
    }
  }, [currentRef, sortOrder]);

  return { openSplitWith, closeSplit, toggleSplit };
}
