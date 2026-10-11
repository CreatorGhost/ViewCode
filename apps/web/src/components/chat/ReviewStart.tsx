import {
  AGENT_REVIEW_MODES,
  type EnvironmentId,
  type PullRequestStartReviewResult,
} from "@t3tools/contracts";
import type { ReviewRereviewBasis } from "@t3tools/client-runtime/review-findings";
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
import { Radio, RadioGroup } from "../ui/radio-group";
import type { RunningReview } from "./useReviewFindingsSource";

export interface ReviewStartTarget {
  readonly environmentId: EnvironmentId;
  readonly request: AgentReviewRequest;
  readonly onStarted: (started: PullRequestStartReviewResult) => void;
}

/**
 * Mode, model and focus for a new agent review, and the button that starts it. With findings to
 * start from, it can re-review them instead: only what changed since, where the earlier review
 * named its commit, with every earlier finding checked again.
 */
export function ReviewStartForm({
  target,
  rereview = null,
}: {
  target: ReviewStartTarget;
  rereview?: ReviewRereviewBasis | null;
}) {
  const form = useAgentReviewForm(target.environmentId, target.request);
  const [scope, setScope] = useState<"rereview" | "full">(() =>
    rereview?.onlyChanges === true ? "rereview" : "full",
  );
  return (
    <form
      className="flex w-full flex-col gap-3 text-left"
      onSubmit={(event) => {
        event.preventDefault();
        const basedOn = rereview !== null && scope === "rereview" ? rereview.basedOn : undefined;
        void form.start(basedOn).then((started) => {
          if (started !== null) target.onStarted(started);
        });
      }}
    >
      {rereview !== null ? (
        <RadioGroup
          aria-label="What to review"
          value={scope}
          onValueChange={(value) => setScope(value === "rereview" ? "rereview" : "full")}
        >
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
            <Radio value="rereview" className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">
                {rereview.onlyChanges
                  ? "Only what changed since this review"
                  : "Check this review's findings again"}
              </span>
              <span className="text-xs text-muted-foreground">
                {rereview.onlyChanges
                  ? "Reads the commits pushed since, and says which of these findings were fixed."
                  : "Reads the whole change again, and says which of these findings were fixed."}
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer items-start gap-3 rounded-lg border px-3 py-2.5 text-sm">
            <Radio value="full" className="mt-0.5" />
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">Full review</span>
              <span className="text-xs text-muted-foreground">
                A fresh review of the whole change.
              </span>
            </span>
          </label>
        </RadioGroup>
      ) : null}
      <AgentReviewFields form={form} />
      <Button type="submit" size="sm" disabled={!form.canStart}>
        {form.pending ? "Starting..." : "Start review"}
      </Button>
    </form>
  );
}

/** The Review toolbar's "Find issues": a new review or a re-review, from a dropdown. */
export function FindIssuesButton({
  target,
  rereview,
}: {
  target: ReviewStartTarget;
  rereview: ReviewRereviewBasis | null;
}) {
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
        {open ? <ReviewStartForm target={closingTarget} rereview={rereview} /> : null}
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
