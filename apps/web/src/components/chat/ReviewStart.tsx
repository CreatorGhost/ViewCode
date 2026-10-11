import {
  AGENT_REVIEW_MODES,
  type EnvironmentId,
  type PullRequestStartReviewResult,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ScanSearchIcon } from "lucide-react";
import { useState } from "react";

import { useServerConfigs } from "../../state/entities";
import {
  AgentReviewFields,
  type AgentReviewRequest,
  useAgentReviewForm,
} from "../pullRequest/PullRequestAgentReviewDialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import type { RunningReview } from "./useReviewFindingsSource";

export interface ReviewStartTarget {
  readonly environmentId: EnvironmentId;
  readonly request: AgentReviewRequest;
  readonly onStarted: (started: PullRequestStartReviewResult) => void;
}

/** Mode, model and focus for a new agent review, and the button that starts it. */
export function ReviewStartForm({ target }: { target: ReviewStartTarget }) {
  const form = useAgentReviewForm(target.environmentId, target.request);
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

/** The Review toolbar's "Find issues": a new review, from a dropdown. */
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

/** "Reviewing… Deep review · Opus 5.5", and the way to the review's chat. */
export function RunningReviewStatus({
  environmentId,
  running,
  label,
}: {
  environmentId: EnvironmentId;
  running: RunningReview;
  label: string;
}) {
  const { instanceId, model: slug } = running.modelSelection;
  const provider = useServerConfigs()
    .get(environmentId)
    ?.providers.find((candidate) => candidate.instanceId === instanceId);
  const model = provider?.models.find((entry) => entry.slug === slug);
  const mode = AGENT_REVIEW_MODES.find((entry) => entry.mode === running.mode)?.label ?? "Review";
  return (
    <p
      role="status"
      className="flex min-w-0 shrink-0 items-center gap-2 border-b border-border/60 px-3 py-1.5 text-muted-foreground text-xs"
    >
      <span className="min-w-0 truncate">
        {label} {mode} · {model?.shortName ?? model?.name ?? slug}
      </span>
      <Link
        to="/$environmentId/$threadId"
        params={{ environmentId, threadId: running.threadId }}
        className="ml-auto shrink-0 text-foreground hover:underline"
      >
        Open chat
      </Link>
    </p>
  );
}
