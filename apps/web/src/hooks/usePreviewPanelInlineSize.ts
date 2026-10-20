import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import {
  readStoredWidth,
  type ResizableWidthHandlers,
  useResizableWidth,
} from "./useResizableWidth";
import { observeResize } from "../lib/observeResize";

export interface PreviewPanelInlineSize {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
}

const PREVIEW_PANEL_WIDTH_STORAGE_KEY = "t3code:preview-panel-width";
const PREVIEW_PANEL_MIN_WIDTH = 360;
const PREVIEW_PANEL_MAX_WIDTH_FRACTION = 0.7;
/**
 * Floor for the column beside the panel: below this the chat column's
 * composer overflows, so the panel yields instead.
 */
const SIBLING_COLUMN_MIN_WIDTH = 360;
const PREVIEW_PANEL_DEFAULT_WIDTH = 540;

export function usePreviewPanelInlineSize(
  hostRef?: RefObject<HTMLElement | null>,
  options: {
    readonly enabled?: boolean | undefined;
    readonly widthStorageKey?: string | undefined;
    readonly defaultWidth?: number | undefined;
    readonly container?: HTMLElement | null | undefined;
  } = {},
): PreviewPanelInlineSize {
  const storageKey = options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY;
  const defaultWidth = options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH;
  // The cap is measured against the stored width, so the measurement starts from it too: the
  // first render cannot wait a tick for the hook below to report it.
  const [desiredWidth, setDesiredWidth] = useState(() => readStoredWidth(storageKey, defaultWidth));
  const { maxWidth, remeasure } = useViewportClampedMaxWidth(
    hostRef,
    options.enabled ?? true,
    options.container,
    desiredWidth,
  );
  const size = useResizableWidth({
    storageKey,
    defaultWidth,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  if (size.desiredWidth !== desiredWidth) setDesiredWidth(size.desiredWidth);
  return {
    width: size.width,
    handlers: {
      ...size.handlers,
      onPointerDown: (event) => {
        // A skipped cap (below) is caught up before the drag's clamp reads it.
        remeasure();
        size.handlers.onPointerDown(event);
      },
    },
  };
}

function useViewportClampedMaxWidth(
  hostRef: RefObject<HTMLElement | null> | undefined,
  enabled: boolean,
  container: HTMLElement | null | undefined,
  desiredWidth: number,
): { readonly maxWidth: number; readonly remeasure: () => void } {
  const [maxWidth, setMaxWidth] = useState(() =>
    getPreviewPanelMaxWidth(typeof window === "undefined" ? 1280 : window.innerWidth),
  );
  const rowRef = useRef<HTMLElement | null>(null);
  const remeasure = () =>
    setMaxWidth(getPreviewPanelMaxWidth(window.innerWidth, rowRef.current?.clientWidth));
  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    const row = container ?? (enabled ? hostRef?.current?.parentElement : null) ?? null;
    rowRef.current = row;
    const cap = () => getPreviewPanelMaxWidth(window.innerWidth, row?.clientWidth);
    // The row resizes every frame of a sidebar slide, and so does the cap once the
    // row is the binding limit. The cap only matters when it clamps the panel's
    // stored width, so a move that leaves that width unclamped either way is not
    // stored: storing it re-rendered the panel's owner (ChatView) on every frame.
    // Compared against the stored width, not the clamped one: a cap that once bit
    // would otherwise never be allowed to let go.
    const measure = () => {
      const next = cap();
      setMaxWidth((current) => (keepsPanelUnclamped(current, next, desiredWidth) ? current : next));
    };
    // Measure before first paint: the persisted width must be clamped against
    // the row on the initial render, not one observer tick later (the panel
    // would flash over-wide on every mount).
    setMaxWidth(cap());
    let frame = 0;
    const onResize = () => {
      if (frame !== 0) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    window.addEventListener("resize", onResize);
    const stopObserving = row ? observeResize(row, measure) : undefined;
    return () => {
      window.removeEventListener("resize", onResize);
      if (frame !== 0) window.cancelAnimationFrame(frame);
      stopObserving?.();
    };
    // Another stored width (a thread switch, a drag) is clamped against the live cap: the effect
    // re-runs for it, and the measurement above is unconditional.
  }, [container, hostRef, enabled, desiredWidth]);
  return { maxWidth, remeasure };
}

function keepsPanelUnclamped(current: number, next: number, desiredWidth: number): boolean {
  return current === next || (next >= desiredWidth && current >= desiredWidth);
}
export function getPreviewPanelMaxWidth(viewportWidth: number, containerWidth?: number): number {
  const fractionCap = Math.floor(viewportWidth * PREVIEW_PANEL_MAX_WIDTH_FRACTION);
  const containerCap =
    containerWidth === undefined ? Infinity : Math.floor(containerWidth) - SIBLING_COLUMN_MIN_WIDTH;
  // Never below the panel's own minimum: when the row cannot fit both
  // columns' minimums the sibling yields, and useResizableWidth's clamp must
  // not see max < min (it would resolve the inversion to min and, via
  // drag-end persistence, overwrite the user's stored width).
  return Math.max(PREVIEW_PANEL_MIN_WIDTH, Math.min(fractionCap, containerCap));
}
