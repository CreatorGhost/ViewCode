import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ListChecksIcon } from "lucide-react";
import { useMemo } from "react";

import { selectActiveRightPanel, useRightPanelStore } from "../../rightPanelStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Header toggle for the Review surface of the right panel. Shown on server threads only. */
export function ReviewHeaderButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  /** A narrow header shows the icon alone. */
  compact: boolean;
}) {
  const threadRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const open = useRightPanelStore(
    (state) => selectActiveRightPanel(state.byThreadKey, threadRef) === "review",
  );
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="chip"
            size={props.compact ? "icon-chip" : "chip"}
            aria-label="Review"
            aria-pressed={open}
            onClick={() => useRightPanelStore.getState().toggle(threadRef, "review")}
          />
        }
      >
        <ListChecksIcon />
        {props.compact ? null : "Review"}
      </TooltipTrigger>
      <TooltipPopup>Review findings for this thread</TooltipPopup>
    </Tooltip>
  );
}
