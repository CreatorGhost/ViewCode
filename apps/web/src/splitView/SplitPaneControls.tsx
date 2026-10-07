import { ArrowLeftRightIcon, XIcon } from "lucide-react";

import { Button } from "../components/ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";

/** Swap and close for a split-view pane, on the pane's own header row. */
export function SplitPaneControls(props: { onSwap: () => void; onClose: () => void }) {
  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Swap panes"
              onClick={props.onSwap}
            />
          }
        >
          <ArrowLeftRightIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Swap panes</TooltipPopup>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              variant="ghost-muted"
              size="icon-xs"
              aria-label="Close pane"
              onClick={props.onClose}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="bottom">Close pane</TooltipPopup>
      </Tooltip>
    </div>
  );
}
