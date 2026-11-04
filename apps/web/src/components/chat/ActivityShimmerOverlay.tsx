import type { ReactNode } from "react";

import { cn } from "~/lib/utils";

/**
 * The live step's moving shine: a copy of the label, masked to a band that sweeps across it on
 * the `live-activity-focus` beat (two sweeps, then a rest). Put it inside a `relative
 * overflow-hidden` label whose container runs `observeVisibleAnimation`, so it only moves while
 * on screen; reduced motion hides it. `className` colours the band (the bright copy).
 */
export function ActivityShimmerOverlay({
  children,
  className,
}: {
  children: ReactNode;
  className?: string | undefined;
}) {
  return (
    <span
      aria-hidden
      className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
    >
      <span className="live-activity-focus-counter block">
        <span className={cn("live-activity-focus-aligned block", className ?? "text-foreground")}>
          {children}
        </span>
      </span>
    </span>
  );
}
