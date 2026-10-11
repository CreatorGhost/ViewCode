import type {
  EnvironmentId,
  PullRequestRef,
  PullRequestStartReviewResult,
} from "@t3tools/contracts";
import { ChevronDownIcon, ScanSearchIcon } from "lucide-react";
import { useState } from "react";

import { AgentReviewFields, useAgentReviewForm } from "../pullRequest/PullRequestAgentReviewDialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

export interface ReviewStartTarget {
  readonly environmentId: EnvironmentId;
  readonly reference: PullRequestRef;
  readonly onStarted: (started: PullRequestStartReviewResult) => void;
}

/** Mode, model and focus for a new agent review of the pull request, and the button that starts it. */
export function ReviewStartForm({ target }: { target: ReviewStartTarget }) {
  const form = useAgentReviewForm(target.environmentId, target.reference);
  return (
    <form
      className="flex w-full flex-col gap-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        void form.start().then((started) => {
          if (started !== null) target.onStarted(started);
        });
      }}
    >
      <AgentReviewFields form={form} />
      <Button type="submit" size="sm" disabled={!form.canStart}>
        {form.pending ? "Starting..." : "Start review"}
      </Button>
    </form>
  );
}

/** The Review toolbar's "Find issues": a new review of the pull request, from a dropdown. */
export function FindIssuesButton({ target }: { target: ReviewStartTarget }) {
  const [open, setOpen] = useState(false);
  const closingTarget: ReviewStartTarget = {
    ...target,
    onStarted: (started) => {
      setOpen(false);
      target.onStarted(started);
    },
  };
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<Button type="button" size="xs" variant="outline" />}>
        <ScanSearchIcon aria-hidden />
        Find issues
        <ChevronDownIcon aria-hidden />
      </PopoverTrigger>
      <PopoverPopup align="end" width="lg">
        {open ? <ReviewStartForm target={closingTarget} /> : null}
      </PopoverPopup>
    </Popover>
  );
}
