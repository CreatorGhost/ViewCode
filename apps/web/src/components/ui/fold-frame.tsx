import { type ReactNode, useEffect, useState } from "react";

import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn } from "~/lib/utils";

/**
 * Folds content closed and open on grid rows (1fr to 0fr, never height) and unmounts it only
 * once the fold has closed, so what is inside stops costing anything. Content that starts
 * folded never mounts. `collapsed` is what stands in while folded, if anything.
 */
const FOLD_FALLBACK_MS = 600;
const afterFold = <T extends { readonly folded: boolean; readonly fullMounted: boolean }>(
  current: T,
): T => (current.folded ? { ...current, fullMounted: false } : current);

export function FoldFrame({
  folded,
  collapsed = null,
  full,
}: {
  folded: boolean;
  collapsed?: ReactNode;
  /** Mounted only while unfolded (or folding). */
  full: ReactNode;
}) {
  const reducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [view, setView] = useState({ folded, fullMounted: !folded, moved: false });
  if (view.folded !== folded) {
    setView({ folded, fullMounted: !folded || !reducedMotion, moved: true });
  }
  const unmountFull = () => setView(afterFold);
  // The fold's transition end unmounts the content; this catches a transition that never ran.
  const closing = view.folded && view.fullMounted;
  useEffect(() => {
    if (!closing) return;
    const timer = window.setTimeout(() => setView(afterFold), FOLD_FALLBACK_MS);
    return () => window.clearTimeout(timer);
  }, [closing]);
  return (
    <div>
      {folded && collapsed !== null ? (
        <div className={view.moved ? "blur-swap" : undefined}>{collapsed}</div>
      ) : null}
      {view.fullMounted ? (
        <div
          className={cn("fold-frame", !folded && view.moved && "fold-frame-open")}
          data-open={!folded}
          onTransitionEnd={(event) => {
            if (event.target === event.currentTarget) unmountFull();
          }}
        >
          <div>{full}</div>
        </div>
      ) : null}
    </div>
  );
}
