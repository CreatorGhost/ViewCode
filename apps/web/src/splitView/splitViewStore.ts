import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../lib/storage";
import {
  parsePersistedSplit,
  SPLIT_DEFAULT_RATIO,
  swapSplitPair,
  type SplitPair,
} from "./splitView.logic";

/**
 * The split pair and divider position. The route thread decides which pane is
 * focused and whether the pair is on screen (see `resolveFocusedPane`), so
 * this store never tracks focus. Persisted so a reload keeps the layout.
 */
interface SplitViewState {
  pair: SplitPair | null;
  /** Fraction of the width the left pane takes. */
  ratio: number;
  setPair: (pair: SplitPair | null) => void;
  setRatio: (ratio: number) => void;
  swap: () => void;
  close: () => void;
}

export const useSplitViewStore = create<SplitViewState>()(
  persist(
    (set) => ({
      pair: null,
      ratio: SPLIT_DEFAULT_RATIO,
      setPair: (pair) => set({ pair }),
      setRatio: (ratio) => set({ ratio }),
      swap: () => set((state) => (state.pair ? { pair: swapSplitPair(state.pair) } : state)),
      close: () => set({ pair: null }),
    }),
    {
      name: "viewcode:split-view:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ pair: state.pair, ratio: state.ratio }),
      merge: (persisted, current) => ({ ...current, ...parsePersistedSplit(persisted) }),
    },
  ),
);
