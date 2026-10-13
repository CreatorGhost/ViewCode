import { VIEWCODE_MARK as mark } from "@t3tools/shared/viewcodeBrand";
import { useId, type SVGProps } from "react";

/** ViewCode's black and teal V. The upstream component name keeps call sites compatible. */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const cutId = useId();
  return (
    <svg {...props} viewBox={mark.viewBox} xmlns="http://www.w3.org/2000/svg" fill="none">
      <defs>
        <mask id={cutId} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
          <rect className="text-white" width="1024" height="1024" fill="currentColor" />
          <path
            className="text-black"
            d={mark.rightPath}
            stroke="currentColor"
            strokeWidth={mark.cutStrokeWidth}
            strokeLinecap="round"
          />
        </mask>
      </defs>
      <g mask={`url(#${cutId})`}>
        {/* A fine edge keeps the black brand stroke legible on dark surfaces. */}
        <path
          className="hidden stroke-foreground dark:block"
          d={mark.leftPath}
          stroke="currentColor"
          strokeOpacity="0.5"
          strokeWidth={mark.outlineStrokeWidth}
          strokeLinecap="round"
        />
        <path
          d={mark.leftPath}
          stroke={mark.black}
          strokeWidth={mark.strokeWidth}
          strokeLinecap="round"
        />
      </g>
      <path
        d={mark.rightPath}
        stroke={mark.teal}
        strokeWidth={mark.strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}
