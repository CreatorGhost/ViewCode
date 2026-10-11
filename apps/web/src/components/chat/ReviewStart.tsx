import type { EnvironmentId } from "@t3tools/contracts";
import type { ReviewRereviewBasis } from "@t3tools/client-runtime/review-findings";
import { ChevronDownIcon, ScanSearchIcon } from "lucide-react";
import { useId, useState } from "react";

import {
  AgentReviewFields,
  type AgentReviewRequest,
  type StartedAgentReview,
  useAgentReviewForm,
  useStartAgentReview,
} from "../pullRequest/PullRequestAgentReviewDialog";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ReviewScopeFields } from "./ReviewScopeFields";
import type { LatestReviewStatus } from "./useReviewFindingsSource";

export interface ReviewStartTarget {
  readonly environmentId: EnvironmentId;
  readonly request: AgentReviewRequest;
  readonly onStarted: (started: StartedAgentReview) => void;
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
  const id = useId();
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
      {form.canScope && !(rereview !== null && scope === "rereview") ? (
        <ReviewScopeFields
          environmentId={target.environmentId}
          cwd={form.checkoutCwd}
          scope={form.scope}
          onScopeChange={form.setScope}
        />
      ) : null}
      {rereview !== null ? (
        <div className="flex flex-col gap-2">
          <span id={`${id}-scope`} className="font-medium text-xs text-muted-foreground">
            Re-review
          </span>
          <ToggleGroup
            aria-labelledby={`${id}-scope`}
            className="w-full *:flex-1"
            value={[scope]}
            onValueChange={(next) => {
              const value = next[0];
              if (value === "rereview" || value === "full") setScope(value);
            }}
          >
            <Toggle value="rereview">
              {rereview.onlyChanges ? "Changes since" : "Check again"}
            </Toggle>
            <Toggle value="full">Full review</Toggle>
          </ToggleGroup>
          <span className="text-xs text-muted-foreground">
            {scope === "full"
              ? "A fresh review of the whole change."
              : rereview.onlyChanges
                ? "Reads the commits pushed since this review, and says which of its findings were fixed."
                : "Reads the whole change again, and says which of this review's findings were fixed."}
          </span>
        </div>
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

/**
 * Starts the latest review again as it was asked for: the same mode, model and focus, on what
 * `target` reviews (the same change, since the review is of this view's chat or pull request).
 */
export function useReviewRetry(
  target: ReviewStartTarget | null,
  review: LatestReviewStatus | null,
): { readonly retry: (() => void) | null; readonly pending: boolean } {
  const starter = useStartAgentReview(target?.environmentId ?? null, target?.request ?? null);
  if (target === null || review === null) return { retry: null, pending: false };
  return {
    pending: starter.pending,
    retry: () => {
      void starter
        .start({
          mode: review.mode,
          modelSelection: review.modelSelection,
          focus: review.focus ?? "",
          scope: review.scope,
        })
        .then((started) => {
          if (started !== null) target.onStarted(started);
        });
    },
  };
}
