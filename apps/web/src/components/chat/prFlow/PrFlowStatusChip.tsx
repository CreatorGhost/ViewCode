import { LoaderCircleIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { type PrFlow, prFlowReached, prFlowStatus } from "./prFlowModel";

const TONE_DOT = {
  warning: "bg-warning",
  success: "bg-success",
  merged: "bg-branch",
} as const;

const TONE_TEXT = {
  busy: "text-muted-foreground",
  warning: "text-warning-foreground",
  success: "text-success-foreground",
  merged: "text-branch",
} as const;

/** The pull request's state above the composer; it follows the card in the thread. */
export function PrFlowStatusChip({ flow }: { flow: PrFlow }) {
  const status = prFlowStatus(flow);
  const creating = !prFlowReached(flow.phase, "conflicts");
  return (
    <span
      className={cn(
        "flex h-6.5 items-center gap-1.5 rounded-full border px-2.5 text-xs whitespace-nowrap",
        creating ? "border-transparent bg-foreground text-background" : "bg-card",
      )}
    >
      <span key={status.short} className="blur-swap flex items-center gap-1.5">
        {status.tone === "busy" ? (
          <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
        ) : (
          <span aria-hidden className={cn("size-1.5 rounded-full", TONE_DOT[status.tone])} />
        )}
        {creating ? null : <span>#{flow.number}</span>}
        <span className={creating ? undefined : TONE_TEXT[status.tone]}>{status.short}</span>
      </span>
    </span>
  );
}
