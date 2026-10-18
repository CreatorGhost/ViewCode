import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Header toggle for the Review surface of the right panel. */
export function ReviewHeaderButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** A narrow header shows the icon alone. */
  compact: boolean;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const open = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "review",
  );
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Button
          variant="chip"
          size={props.compact ? "icon-chip" : "chip"}
          aria-label="Review"
          aria-pressed={open}
          data-pressed={open || undefined}
          disabled={props.disabled}
          onClick={() => {
            if (props.disabled) return;
            useRightPanelStore.getState().toggle(threadRef, "review");
          }}
        >
          <ListChecksIcon />
          {props.compact ? null : "Review"}
        </Button>
      </TooltipTrigger>
      <TooltipPopup>
        {props.disabled
          ? (props.disabledReason ?? "Review is unavailable for this thread")
          : "Review findings for this thread"}
      </TooltipPopup>
    </Tooltip>
  );
}
