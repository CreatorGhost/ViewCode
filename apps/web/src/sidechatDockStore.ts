/**
 * Side chat dock state, keyed by the parent thread: whether the dock is open,
 * which side chat it shows, and its width. Closing keeps the side chat, so
 * reopening shows the same conversation. `prefill` is a one-shot question the
 * dock drops into its composer (the "Ask in side chat" selection action).
 */
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { SidechatPreference } from "./components/chat/sidechat.logic";
import { resolveStorage } from "./lib/storage";

export const SIDECHAT_DOCK_MIN_WIDTH_PX = 300;
export const SIDECHAT_DOCK_MAX_WIDTH_PX = 640;
export const SIDECHAT_DOCK_DEFAULT_WIDTH_PX = 380;

export interface SidechatDockState {
  readonly open: boolean;
  /** The side chat last shown for this parent, or "fresh" after "New side chat". */
  readonly activeThreadId: SidechatPreference;
  readonly prefill: string | null;
}

const CLOSED: SidechatDockState = { open: false, activeThreadId: null, prefill: null };

interface SidechatDockStoreState {
  byParentKey: Record<string, SidechatDockState>;
  widthPx: number;
  open: (parent: ScopedThreadRef, input?: { prefill?: string | undefined }) => void;
  close: (parent: ScopedThreadRef) => void;
  toggle: (parent: ScopedThreadRef) => void;
  setActive: (parent: ScopedThreadRef, threadId: SidechatPreference) => void;
  consumePrefill: (parent: ScopedThreadRef) => string | null;
  setWidth: (widthPx: number) => void;
}

export function clampSidechatDockWidth(widthPx: number): number {
  if (!Number.isFinite(widthPx)) return SIDECHAT_DOCK_DEFAULT_WIDTH_PX;
  return Math.min(SIDECHAT_DOCK_MAX_WIDTH_PX, Math.max(SIDECHAT_DOCK_MIN_WIDTH_PX, widthPx));
}

const patch = (
  state: SidechatDockStoreState,
  parent: ScopedThreadRef,
  next: Partial<SidechatDockState>,
) => {
  const key = scopedThreadKey(parent);
  return {
    byParentKey: {
      ...state.byParentKey,
      [key]: { ...(state.byParentKey[key] ?? CLOSED), ...next },
    },
  };
};

export const useSidechatDockStore = create<SidechatDockStoreState>()(
  persist(
    (set, get) => ({
      byParentKey: {},
      widthPx: SIDECHAT_DOCK_DEFAULT_WIDTH_PX,
      open: (parent, input) =>
        set((state) =>
          patch(state, parent, {
            open: true,
            ...(input?.prefill ? { prefill: input.prefill } : {}),
          }),
        ),
      close: (parent) => set((state) => patch(state, parent, { open: false })),
      toggle: (parent) =>
        set((state) =>
          patch(state, parent, {
            open: !(state.byParentKey[scopedThreadKey(parent)]?.open ?? false),
          }),
        ),
      setActive: (parent, threadId) =>
        set((state) => patch(state, parent, { activeThreadId: threadId })),
      consumePrefill: (parent) => {
        const prefill = get().byParentKey[scopedThreadKey(parent)]?.prefill ?? null;
        if (prefill !== null) set((state) => patch(state, parent, { prefill: null }));
        return prefill;
      },
      setWidth: (widthPx) => set({ widthPx: clampSidechatDockWidth(widthPx) }),
    }),
    {
      name: "viewcode:sidechat-dock:v1",
      version: 1,
      storage: createJSONStorage(() => resolveStorage(window.localStorage)),
      // A prefill is a pending hand-off, never worth restoring after a restart.
      partialize: (state) => ({
        widthPx: state.widthPx,
        byParentKey: Object.fromEntries(
          Object.entries(state.byParentKey).map(([key, value]) => [
            key,
            { ...value, prefill: null },
          ]),
        ),
      }),
    },
  ),
);

export function selectSidechatDock(
  byParentKey: Record<string, SidechatDockState>,
  parent: ScopedThreadRef | null | undefined,
): SidechatDockState {
  if (!parent) return CLOSED;
  return byParentKey[scopedThreadKey(parent)] ?? CLOSED;
}

/**
 * Opens the side chat dock beside `parent`, optionally with a question already
 * in its composer. Callable from anywhere (selection toolbar, palette, keys).
 */
export function openSideChat(parent: ScopedThreadRef, prefill?: string): void {
  useSidechatDockStore.getState().open(parent, { prefill });
}
