import type { ScopedThreadRef } from "@t3tools/contracts";

import { useOpenLink } from "~/browser/useOpenLink";
import { observeChipGlide } from "~/lib/chipGlide";
import { PrFlowCard } from "./PrFlowCard";
import { PrFlowStatusChip } from "./PrFlowStatusChip";
import { useThreadPrFlow } from "./useThreadPrFlow";

/**
 * The thread's pull request as a PR flow card: while the git menu opens one, then live from the
 * host and the checkout, with Resolve conflicts and Merge. `compact` (the Review panel, or a
 * merge that is no longer news) keeps the header and the footer.
 */
export function ThreadPrFlowCard({
  threadRef,
  compact = false,
}: {
  threadRef: ScopedThreadRef;
  compact?: boolean;
}) {
  const { flow, staleMerge, resolveConflicts, merge } = useThreadPrFlow(threadRef, {
    detailed: !compact,
    follow: !compact,
  });
  const openLink = useOpenLink(threadRef);
  if (flow === null) return null;
  return (
    <PrFlowCard
      flow={flow}
      compact={compact || staleMerge}
      onResolveConflicts={resolveConflicts}
      onMerge={merge}
      onOpen={(url) => void openLink(url)}
    />
  );
}

/**
 * The pull request's state above the composer, following the card, beside its diff size. Gone
 * once a merge is no longer news.
 */
export function ThreadPrStatusChips({ threadRef }: { threadRef: ScopedThreadRef }) {
  // The chat's card follows the agent; the chip reads what it fetched.
  const { flow, staleMerge } = useThreadPrFlow(threadRef, { detailed: true, follow: false });
  if (flow === null || staleMerge) return null;
  return (
    <div ref={observeChipGlide} className="pointer-events-none relative flex gap-1.5 pb-2">
      <PrFlowStatusChip flow={flow} />
      {flow.additions === null || flow.deletions === null ? null : (
        <span className="flex h-6.5 items-center gap-1.5 rounded-full border bg-card px-2.5 font-mono text-xs">
          <span className="text-diff-addition-foreground">+{flow.additions}</span>
          <span className="text-diff-deletion-foreground">−{flow.deletions}</span>
        </span>
      )}
    </div>
  );
}
