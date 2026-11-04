import { cn } from "~/lib/utils";
import { PullRequestGlyph } from "../../pullRequest/pullRequestIcons";
import { Spinner } from "../../ui/spinner";
import { type PrFlow, prFlowReached, prFlowStatus } from "@t3tools/client-runtime/pr-flow";

const TONE_DOT = {
  warning: "bg-warning",
  success: "bg-success",
} as const;

const TONE_TEXT = {
  busy: "text-muted-foreground",
  warning: "text-warning-foreground",
  success: "text-success-foreground",
  merged: "text-branch",
} as const;

/**
 * The pull request's state above the composer; it reads the same flow as the card. The fill and
 * border are a separate surface so a row watched by observeChipGlide can tween the chip's width.
 */
export function PrFlowStatusChip({ flow }: { flow: PrFlow }) {
  const status = prFlowStatus(flow);
  // Before the host has a number for it, the chip just says the pull request is on its way.
  const creating = !prFlowReached(flow.phase, "checking");
  return (
    <span className="relative flex h-6.5 items-center px-2.5 text-xs whitespace-nowrap">
      <span
        aria-hidden
        data-chip-surface
        className="absolute inset-0 origin-left rounded-full border bg-card"
      />
      <span key={status.short} className="blur-swap relative flex items-center gap-1.5">
        {status.tone === "busy" ? (
          <Spinner size="xs" tone="muted" />
        ) : status.tone === "merged" ? (
          <PullRequestGlyph.merged aria-hidden className="size-3 text-branch" />
        ) : (
          <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} />
        )}
        {creating ? null : <span>#{flow.number}</span>}
        <span className={creating ? "text-foreground/85" : TONE_TEXT[status.tone]}>
          {status.short}
        </span>
      </span>
    </span>
  );
}
