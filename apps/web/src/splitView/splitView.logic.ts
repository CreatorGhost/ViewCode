import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";

/** Two server threads shown side by side; index 0 is the left pane. */
export type SplitPair = readonly [ScopedThreadRef, ScopedThreadRef];

export const SPLIT_DEFAULT_RATIO = 0.5;
/** Narrowest a pane may get before the composer and header stop fitting. */
export const SPLIT_MIN_PANE_WIDTH = 360;
/** Viewport width below which split falls back to the single view. */
export const SPLIT_MIN_VIEWPORT_WIDTH = 1024;

export function clampSplitRatio(ratio: number, containerWidth: number): number {
  if (!Number.isFinite(ratio)) return SPLIT_DEFAULT_RATIO;
  // A container too narrow for two minimum panes just pins to the middle.
  const minRatio = containerWidth > 0 ? SPLIT_MIN_PANE_WIDTH / containerWidth : 0.25;
  if (minRatio >= 0.5) return SPLIT_DEFAULT_RATIO;
  return Math.min(1 - minRatio, Math.max(minRatio, ratio));
}

export function isSameThreadRef(a: ScopedThreadRef, b: ScopedThreadRef): boolean {
  return a.environmentId === b.environmentId && a.threadId === b.threadId;
}

/**
 * Pair for "open `target` beside `current`". Null when there is nothing to
 * split with (no current thread, or the same thread twice).
 */
export function buildSplitPair(
  current: ScopedThreadRef | null,
  target: ScopedThreadRef,
): SplitPair | null {
  if (current === null || isSameThreadRef(current, target)) return null;
  return [current, target];
}

export function swapSplitPair(pair: SplitPair): SplitPair {
  return [pair[1], pair[0]];
}

/** Index of the pane showing the route thread, or null when the pair is not on screen. */
export function resolveFocusedPane(pair: SplitPair | null, routeKey: string | null): 0 | 1 | null {
  if (pair === null || routeKey === null) return null;
  if (scopedThreadKey(pair[0]) === routeKey) return 0;
  if (scopedThreadKey(pair[1]) === routeKey) return 1;
  return null;
}

/** The thread that stays on screen when pane `index` closes. */
export function remainingAfterClose(pair: SplitPair, index: 0 | 1): ScopedThreadRef {
  return pair[index === 0 ? 1 : 0];
}

/** Most recent thread other than the current one; callers pass threads newest first. */
export function pickSplitCompanion<
  T extends { environmentId: string; id: string; archivedAt: string | null },
>(threadsNewestFirst: ReadonlyArray<T>, current: ScopedThreadRef | null): T | null {
  for (const thread of threadsNewestFirst) {
    if (thread.archivedAt !== null) continue;
    if (
      current !== null &&
      thread.environmentId === current.environmentId &&
      thread.id === current.threadId
    ) {
      continue;
    }
    return thread;
  }
  return null;
}

function parseRef(value: unknown): ScopedThreadRef | null {
  if (typeof value !== "object" || value === null) return null;
  const { environmentId, threadId } = value as Record<string, unknown>;
  if (typeof environmentId !== "string" || environmentId === "") return null;
  if (typeof threadId !== "string" || threadId === "") return null;
  return { environmentId, threadId } as ScopedThreadRef;
}

/** Defensive read of persisted state; anything malformed means "no split". */
export function parsePersistedSplit(value: unknown): { pair: SplitPair | null; ratio: number } {
  const record =
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const ratio =
    typeof record.ratio === "number" &&
    Number.isFinite(record.ratio) &&
    record.ratio > 0 &&
    record.ratio < 1
      ? record.ratio
      : SPLIT_DEFAULT_RATIO;
  const pairValue = Array.isArray(record.pair) ? record.pair : null;
  const first = parseRef(pairValue?.[0]);
  const second = parseRef(pairValue?.[1]);
  if (first === null || second === null || isSameThreadRef(first, second)) {
    return { pair: null, ratio };
  }
  return { pair: [first, second], ratio };
}
