/**
 * Open-thread tabs above the chat, one list per environment so a thread on another machine never
 * shows up among this one's tabs. Only the tab list persists; recent-use order is session-only.
 */
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { closeThreadTab, openThreadTab, touchRecentView } from "./components/tabs/threadTabs.logic";
import { resolveStorage } from "./lib/storage";

interface ThreadTabsState {
  tabsByEnvironmentId: Record<string, ReadonlyArray<string>>;
  /** Most recently used first; feeds the Ctrl-Tab switcher. Not persisted. */
  recentThreadKeys: ReadonlyArray<string>;
  open: (environmentId: string, threadKey: string) => void;
  close: (environmentId: string, threadKey: string, activeKey: string | null) => string | null;
  prune: (environmentId: string, exists: (threadKey: string) => boolean) => void;
}

export const useThreadTabsStore = create<ThreadTabsState>()(
  persist(
    (set, get) => ({
      tabsByEnvironmentId: {},
      recentThreadKeys: [],
      open: (environmentId, threadKey) =>
        set((state) => {
          const tabs = state.tabsByEnvironmentId[environmentId] ?? [];
          const recentThreadKeys = touchRecentView(state.recentThreadKeys, threadKey);
          // A new tab lands beside the thread the user came from.
          const opened = openThreadTab(tabs, threadKey, state.recentThreadKeys[0] ?? null);
          return opened === tabs
            ? { recentThreadKeys }
            : {
                recentThreadKeys,
                tabsByEnvironmentId: { ...state.tabsByEnvironmentId, [environmentId]: opened },
              };
        }),
      close: (environmentId, threadKey, activeKey) => {
        const tabs = get().tabsByEnvironmentId[environmentId] ?? [];
        const result = closeThreadTab(tabs, threadKey, activeKey);
        set((state) => ({
          tabsByEnvironmentId: { ...state.tabsByEnvironmentId, [environmentId]: result.tabs },
          recentThreadKeys: state.recentThreadKeys.filter((key) => key !== threadKey),
        }));
        return result.nextActiveKey;
      },
      prune: (environmentId, exists) =>
        set((state) => {
          const tabs = state.tabsByEnvironmentId[environmentId] ?? [];
          const kept = tabs.filter(exists);
          return kept.length === tabs.length
            ? state
            : { tabsByEnvironmentId: { ...state.tabsByEnvironmentId, [environmentId]: kept } };
        }),
    }),
    {
      name: "viewcode:thread-tabs:v1",
      version: 1,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ tabsByEnvironmentId: state.tabsByEnvironmentId }),
    },
  ),
);
