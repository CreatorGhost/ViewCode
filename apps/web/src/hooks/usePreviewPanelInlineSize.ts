import { type RefObject, useLayoutEffect, useRef, useState } from "react";

import { type ResizableWidthHandlers, useResizableWidth } from "./useResizableWidth";
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
  const widthRef = useRef(options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH);
  const { maxWidth, remeasure } = useViewportClampedMaxWidth(
    hostRef,
    options.enabled ?? true,
    options.container,
    widthRef,
  );
  const size = useResizableWidth({
    storageKey: options.widthStorageKey ?? PREVIEW_PANEL_WIDTH_STORAGE_KEY,
    defaultWidth: options.defaultWidth ?? PREVIEW_PANEL_DEFAULT_WIDTH,
    minWidth: PREVIEW_PANEL_MIN_WIDTH,
    maxWidth,
    edge: "left",
  });
  useLayoutEffect(() => {
    widthRef.current = size.width;
  }, [size.width]);
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
  widthRef: RefObject<number>,
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
    // row is the binding limit. The cap only matters when it clamps the panel, so a
    // move that leaves the panel unclamped either way is not stored: storing it
    // re-rendered the panel's owner (ChatView) on every frame of the slide.
    const measure = () => {
      const next = cap();
      setMaxWidth((current) =>
        keepsPanelUnclamped(current, next, widthRef.current) ? current : next,
      );
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
  }, [container, hostRef, enabled, widthRef]);
  return { maxWidth, remeasure };
}

function keepsPanelUnclamped(current: number, next: number, width: number): boolean {
  return current === next || (next >= width && current >= width);
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
