import { CircleAlertIcon } from "lucide-react";

import { BlurSwap } from "~/components/ui/blur-swap";
import { Spinner } from "~/components/ui/spinner";

import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { ComposerBanner } from "./ComposerBanner";

export function ComposerActivityRow({ phase }: { readonly phase: ThreadSyncPhase }) {
  return (
    <ComposerBanner.Row>
      <ComposerBanner.Icon>
        {phase === "stalled" ? <CircleAlertIcon aria-hidden /> : <Spinner />}
      </ComposerBanner.Icon>
      <ComposerBanner.Content>
        <span
          className="shrink-0 whitespace-nowrap text-muted-foreground"
          data-composer-sync-status={phase}
          role="status"
        >
          <BlurSwap swapKey={phase}>{threadSyncLabel(phase)}</BlurSwap>
        </span>
      </ComposerBanner.Content>
    </ComposerBanner.Row>
  );
}
