import type { SVGProps } from "react";

/** ViewCode's ⟨V⟩ mark (the component keeps T3's name so upstream call sites merge cleanly). */
export function T3Wordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="90 165 332 182" xmlns="http://www.w3.org/2000/svg" fill="none">
      <path
        d="M150 180 L110 256 L150 332 M362 180 L402 256 L362 332"
        stroke="currentColor"
        strokeWidth="30"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M196 188 L256 330 L316 188"
        stroke="currentColor"
        strokeWidth="34"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
