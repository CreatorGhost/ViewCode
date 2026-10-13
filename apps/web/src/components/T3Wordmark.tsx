import { VIEWCODE_MARK as mark } from "@t3tools/shared/viewcodeBrand";
import type { SVGProps } from "react";

import { useTheme } from "../hooks/useTheme";

/** Flat code-bracket/git-branch emblem for small UI, keeping the upstream name. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const { resolvedTheme } = useTheme();
  const fill = resolvedTheme === "dark" ? "#ffffff" : mark.ink;
  return (
    <svg {...props} viewBox={mark.viewBox} xmlns="http://www.w3.org/2000/svg" fill="none">
      <path d={mark.bracketPath} fill={fill} />
      <g transform="translate(1000 0) scale(-1 1)">
        <path d={mark.bracketPath} fill={fill} />
      </g>
      {mark.branchPaths.map((d) => (
        <path key={d} d={d} stroke={fill} strokeWidth={mark.branchStrokeWidth} />
      ))}
      {mark.ringPaths.map((d) => (
        <path key={d} d={d} fill={fill} fillRule="evenodd" />
      ))}
      {mark.nodeCenters.map(([cx, cy]) => (
        <circle key={cx} cx={cx} cy={cy} r={mark.nodeDotRadius} fill={mark.teal} />
      ))}
    </svg>
  );
}
