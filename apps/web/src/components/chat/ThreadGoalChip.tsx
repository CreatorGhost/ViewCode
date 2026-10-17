import type { ThreadGoal } from "@t3tools/contracts";
import { PauseIcon, TargetIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** The thread's goal in the chat header; a click opens the goal editor. */
export function ThreadGoalChip(props: { readonly goal: ThreadGoal; readonly onEdit: () => void; readonly disabled?: boolean }) {
  const paused = props.goal.pausedAt !== null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="chip"
            size="chip"
            aria-label={paused ? "Goal (paused): edit" : "Goal: edit"}
            data-thread-goal={paused ? "paused" : "active"}
            disabled={props.disabled}
            onClick={props.onEdit}
          />
        }
      >
        {paused ? <PauseIcon aria-hidden="true" /> : <TargetIcon aria-hidden="true" />}
        <span className="max-w-48 truncate">
          {paused ? "Paused: " : ""}
          {props.goal.objective}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom" className="max-w-80 whitespace-pre-wrap">
        {paused ? "Goal (paused, not sent to the agent)" : "Goal, sent with every message"}
        {"\n"}
        {props.goal.objective}
      </TooltipPopup>
    </Tooltip>
  );
}
