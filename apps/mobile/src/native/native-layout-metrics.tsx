import { createContext, use } from "react";

/**
 * Upstream ViewCode measures UIKit's layout regions here for its iOS column navigator. ViewCode
 * has no such navigator, so nothing provides these and readers fall back to window metrics.
 */
export interface NativeLayoutMetrics {
  readonly width: number;
  readonly height: number;
  readonly horizontalSizeClass: "compact" | "regular";
  readonly verticalBarEdge: "none" | "left" | "right";
  readonly safeArea: {
    readonly top: number;
    readonly bottom: number;
    readonly left: number;
    readonly right: number;
  };
}

const NativeLayoutContext = createContext<NativeLayoutMetrics | null>(null);
export const NativeColumnLayoutMetricsContext = createContext<NativeLayoutMetrics | null>(null);

export function useNativeLayoutMetrics() {
  return use(NativeLayoutContext);
}

export function useNativeColumnLayoutMetrics() {
  return use(NativeColumnLayoutMetricsContext);
}
