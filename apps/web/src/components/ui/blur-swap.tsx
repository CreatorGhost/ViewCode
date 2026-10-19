"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import { Fragment, useState } from "react";

import { cn } from "~/lib/utils";
import { advanceBlurSwap, initialBlurSwap, type BlurSwapKey } from "./blur-swap.logic";

interface BlurSwapProps extends useRender.ComponentProps<"span"> {
  /** The state the content shows. A new key remounts the content and softens it in. */
  swapKey: BlurSwapKey;
  /** Animate the first mount too, for content that only mounts because its state changed. */
  appear?: boolean;
}

/**
 * A status label, chip or counter that cuts to its new state and softens in (the `blur-swap`
 * keyframe). Transforms need a box, so the default span is inline-block; pass `render` to
 * animate an element of your own, such as a truncating `<p>`.
 */
function BlurSwap({ swapKey, appear = false, render, className, ...props }: BlurSwapProps) {
  const [state, setState] = useState(() => initialBlurSwap(swapKey, appear));
  const next = advanceBlurSwap(state, swapKey);
  if (next !== state) setState(next);

  const defaultProps = {
    className: cn(render === undefined && "inline-block", next.swaps > 0 && "blur-swap", className),
    "data-slot": "blur-swap",
  };
  const element = useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
  return <Fragment key={next.swaps}>{element}</Fragment>;
}

export { BlurSwap };
