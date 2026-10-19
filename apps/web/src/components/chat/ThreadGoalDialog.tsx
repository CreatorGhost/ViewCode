import { THREAD_GOAL_MAX_CHARS, type ThreadGoal } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Textarea } from "../ui/textarea";

/**
 * Edits a thread's goal: the objective, pause or resume, and clear. A draft's goal cannot be
 * paused (`canPause` false); it applies from the first send.
 */
export function ThreadGoalDialog(props: {
  readonly goal: ThreadGoal | null;
  readonly canPause: boolean;
  readonly disabled?: boolean;
  readonly onSave: (objective: string) => void;
  readonly onSetPaused: (paused: boolean) => void;
  readonly onClear: () => void;
  readonly onClose: () => void;
}) {
  const id = useId();
  const [objective, setObjective] = useState(props.goal?.objective ?? "");
  const trimmed = objective.trim();
  const paused = props.goal?.pausedAt != null;
  const tooLong = trimmed.length > THREAD_GOAL_MAX_CHARS;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-md">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            if (props.disabled || trimmed === "" || tooLong) return;
            if (trimmed !== props.goal?.objective) props.onSave(trimmed);
            props.onClose();
          }}
        >
          <DialogHeader>
            <DialogTitle>Thread goal</DialogTitle>
            <DialogDescription>
              The agent is given this goal with every message while it is active.
              {paused ? " It is paused now." : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor={`${id}-objective`}>What does done look like?</Label>
              <Textarea
                id={`${id}-objective`}
                autoFocus
                placeholder="All tests in packages/api pass"
                value={objective}
                aria-invalid={tooLong || undefined}
                onChange={(event) => setObjective(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
              />
              {tooLong ? (
                <p role="alert" className="text-destructive text-xs">
                  Keep the goal under {THREAD_GOAL_MAX_CHARS} characters.
                </p>
              ) : null}
            </div>
          </DialogPanel>
          <DialogFooter>
            {props.goal !== null ? (
              <Button
                type="button"
                variant="destructive-outline"
                disabled={props.disabled}
                onClick={() => {
                  props.onClear();
                  props.onClose();
                }}
              >
                Clear goal
              </Button>
            ) : null}
            {props.goal !== null && props.canPause ? (
              <Button
                type="button"
                variant="outline"
                disabled={props.disabled}
                onClick={() => {
                  props.onSetPaused(!paused);
                  props.onClose();
                }}
              >
                {paused ? "Resume" : "Pause"}
              </Button>
            ) : null}
            <Button type="submit" disabled={props.disabled || trimmed === "" || tooLong}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
