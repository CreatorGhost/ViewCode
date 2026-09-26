import { useId, type SVGProps } from "react";

/**
 * ViewCode's interlocked V mark, in `currentColor` (source: `assets/viewcode-mark.svg`).
 * The component keeps T3's name so upstream call sites merge cleanly.
 */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  const cutId = useId();
  return (
    <svg {...props} viewBox="250 232 524 572" xmlns="http://www.w3.org/2000/svg" fill="none">
      <mask id={cutId} maskUnits="userSpaceOnUse" x="0" y="0" width="1024" height="1024">
        <rect width="1024" height="1024" fill="#fff" />
        <path d="M706 300 L512 736" stroke="#000" strokeWidth="176" strokeLinecap="round" />
      </mask>
      <path
        d="M318 300 L512 736"
        stroke="currentColor"
        strokeOpacity="0.55"
        strokeWidth="124"
        strokeLinecap="round"
        mask={`url(#${cutId})`}
      />
      <path d="M706 300 L512 736" stroke="currentColor" strokeWidth="124" strokeLinecap="round" />
    </svg>
  );
}
