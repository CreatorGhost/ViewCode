import type { ThreadGoalRunState } from "@t3tools/client-runtime/threadGoal";
import type { ThreadGoal } from "@t3tools/contracts";
import { PauseIcon, PlayIcon, TargetIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The thread's goal in the chat header; a click opens the goal editor. Beside it, Run goal sends
 * the message that starts the agent on it, offered only while the thread is idle.
 */
export function ThreadGoalChip(props: {
  readonly goal: ThreadGoal;
  readonly onEdit: () => void;
  readonly disabled?: boolean;
  readonly run?: {
    readonly state: ThreadGoalRunState;
    readonly blockedReason: string | null;
    readonly onRun: () => void;
  };
}) {
  const paused = props.goal.pausedAt !== null;
  const run = props.run;
  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              variant="header"
              size="header"
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
      {run && (run.state === "ready" || run.state === "blocked") ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                variant="header"
                size="icon-header"
                aria-label="Run goal"
                disabled={props.disabled}
                // Not `disabled`, so the tooltip can still say why it can't run.
                aria-disabled={run.state !== "ready" || undefined}
                onClick={() => {
                  if (run.state === "ready") run.onRun();
                }}
              />
            }
          >
            <PlayIcon aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="bottom">
            {run.state === "ready" ? "Run goal" : `Can't run the goal: ${run.blockedReason}`}
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}
