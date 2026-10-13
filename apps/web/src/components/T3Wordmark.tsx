import { VIEWCODE_MARK as mark } from "@t3tools/shared/viewcodeBrand";
import type { SVGProps } from "react";

import { useTheme } from "../hooks/useTheme";

/** Flat code-bracket/git-branch emblem for small UI, keeping the upstream name. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const { resolvedTheme } = useTheme();
  return (
    <svg {...props} viewBox={mark.viewBox} xmlns="http://www.w3.org/2000/svg" fill="none">
      <path d={mark.bracketPath} fill={mark.teal} />
      <g transform="translate(1000 0) scale(-1 1)">
        <path d={mark.bracketPath} fill={resolvedTheme === "dark" ? mark.darkSlate : mark.slate} />
      </g>
      {mark.branchPaths.map((d) => (
        <path key={d} d={d} stroke={mark.teal} strokeWidth={mark.branchStrokeWidth} />
      ))}
      {mark.ringPaths.map((d) => (
        <path key={d} d={d} fill={mark.teal} fillRule="evenodd" />
      ))}
    </svg>
  );
}
