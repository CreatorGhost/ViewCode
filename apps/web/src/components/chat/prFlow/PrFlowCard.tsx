import { CheckIcon, LoaderCircleIcon, TriangleAlertIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { PULL_REQUEST_STATE_PRESENTATION } from "../../pullRequest/pullRequestIcons";
import { Button } from "../../ui/button";
import { PrBranchMap } from "./PrBranchMap";
import { type PrFlow, prFlowConflictCount, prFlowReached, prFlowStatus } from "./prFlowModel";

/**
 * A pull request in the chat, from the first commit to merged: what it is, a branch map of
 * where it stands against its base, and one row with the current state and the next action.
 * `compact` leaves out the branch map, for the Review panel.
 */
export function PrFlowCard({
  flow,
  compact = false,
  onResolveConflicts,
  onMerge,
}: {
  flow: PrFlow;
  compact?: boolean;
  onResolveConflicts?: (() => void) | undefined;
  onMerge?: (() => void) | undefined;
}) {
  const merged = flow.phase === "merged";
  const opened = prFlowReached(flow.phase, "opening");
  const state = PULL_REQUEST_STATE_PRESENTATION[merged ? "merged" : "open"];
  const StateIcon = state.Icon;

  return (
    <div
      className={cn(
        "blur-swap flex flex-col rounded-xl border bg-card text-sm",
        compact ? "gap-1.5 p-2.5" : "gap-2.5 p-3",
      )}
    >
      <div className="flex items-start gap-2.5 px-0.5">
        <StateIcon
          aria-hidden
          className={cn(
            "mt-0.5 size-4 shrink-0 transition-colors",
            opened ? state.toneClassName : "text-muted-foreground",
          )}
        />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <div className="flex items-baseline gap-1.5">
            <span className="truncate font-medium">{flow.title}</span>
            {flow.number !== null && opened ? (
              <span className="blur-swap text-muted-foreground">#{flow.number}</span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 font-mono text-2xs text-muted-foreground">
            <span className="max-w-full truncate rounded bg-muted px-1.5">{flow.head}</span>
            {flow.base === null ? null : (
              <>
                <span aria-hidden>→</span>
                <span className="rounded bg-muted px-1.5">{flow.base}</span>
              </>
            )}
            {flow.commitCount === null ? null : (
              <span key={flow.commitCount} className="blur-swap font-sans">
                {flow.commitCount} commit{flow.commitCount === 1 ? "" : "s"}
              </span>
            )}
            {flow.additions === null || flow.deletions === null ? null : (
              <span>
                <span className="text-diff-addition-foreground">+{flow.additions}</span>{" "}
                <span className="text-diff-deletion-foreground">−{flow.deletions}</span>
              </span>
            )}
          </div>
        </div>
        {opened ? (
          <span
            key={merged ? "merged" : "open"}
            className={cn("blur-swap flex items-center gap-1 text-xs", state.toneClassName)}
          >
            <StateIcon aria-hidden className="size-3.5" />
            {state.label}
          </span>
        ) : null}
      </div>
      {compact ? null : <PrBranchMap flow={flow} />}
      {prFlowReached(flow.phase, "conflicts") ? (
        <PrFlowStateRow flow={flow} onResolveConflicts={onResolveConflicts} onMerge={onMerge} />
      ) : null}
    </div>
  );
}

function PrFlowStateRow({
  flow,
  onResolveConflicts,
  onMerge,
}: {
  flow: PrFlow;
  onResolveConflicts?: (() => void) | undefined;
  onMerge?: (() => void) | undefined;
}) {
  const status = prFlowStatus(flow);
  const conflictPhase = flow.phase === "conflicts" || flow.phase === "resolving";
  const base = flow.base ?? "the base";
  const conflictCount = prFlowConflictCount(flow);
  const variant = conflictPhase
    ? "conflicts"
    : flow.phase === "testing"
      ? "testing"
      : flow.phase === "merged"
        ? "merged"
        : flow.checksFailed
          ? "failed"
          : "ready";
  const title =
    variant === "conflicts"
      ? `${conflictCount === 0 ? "Conflicts" : `${conflictCount} conflicts`} with ${base}`
      : status.label;
  const detail =
    variant === "conflicts"
      ? flow.phase === "resolving"
        ? status.label
        : flow.conflicts?.author
          ? `${flow.conflicts.author} changed the same lines in ${base}`
          : `${base} changed the same lines since this branch left it`
      : variant === "testing"
        ? flow.tests === null
          ? `Waiting for the checks on ${flow.head}`
          : `Merged ${base} into ${flow.head}`
        : variant === "failed"
          ? "Open the pull request to see which checks failed"
          : variant === "ready"
            ? flow.tests === null
              ? `No conflicts with ${base}`
              : `${flow.tests.total} tests passed · lint · types`
            : null;

  return (
    <div className="pr-flow-open">
      <div>
        <div className="flex items-start gap-2.5 px-0.5 pt-1">
          <div key={`state-${variant}`} className="blur-swap flex min-w-0 flex-1 gap-2.5">
            <PrFlowStateIcon variant={variant} />
            <div className="flex min-w-0 flex-col gap-0.5">
              <span>{title}</span>
              {detail === null ? null : (
                <span className="text-xs text-muted-foreground">{detail}</span>
              )}
              {variant === "testing" && flow.tests ? (
                <span className="mt-1.5 block h-0.5 w-56 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full origin-left bg-success transition-transform duration-100 ease-linear"
                    style={{ transform: `scaleX(${flow.tests.passed / flow.tests.total})` }}
                  />
                </span>
              ) : null}
            </div>
          </div>
          <span key={`action-${flow.phase}`} className="blur-swap shrink-0">
            <PrFlowAction flow={flow} onResolveConflicts={onResolveConflicts} onMerge={onMerge} />
          </span>
        </div>
        {conflictPhase && flow.conflicts ? (
          <div className="flex flex-wrap gap-1.5 pt-2 pl-7">
            {flow.conflicts.files.map((file, index) => {
              const fixed = flow.phase === "resolving" && flow.conflicts!.resolved > index;
              return (
                <span
                  key={file.path}
                  className="blur-swap flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs"
                  style={{ animationDelay: `${120 + index * 100}ms` }}
                >
                  <span className="font-mono text-3xs font-semibold text-info-foreground">TS</span>
                  {file.path}
                  {fixed ? (
                    <CheckIcon aria-label="resolved" className="blur-swap size-3 text-success" />
                  ) : (
                    <span className="font-mono text-warning-foreground">{file.count}</span>
                  )}
                </span>
              );
            })}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PrFlowStateIcon({
  variant,
}: {
  variant: "conflicts" | "testing" | "ready" | "failed" | "merged";
}) {
  if (variant === "conflicts" || variant === "failed") {
    return <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />;
  }
  if (variant === "testing") {
    return (
      <LoaderCircleIcon
        aria-hidden
        className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground"
      />
    );
  }
  if (variant === "ready") {
    return (
      <svg
        aria-hidden
        viewBox="0 0 16 16"
        className="mt-0.5 size-4 shrink-0 text-success"
        fill="none"
      >
        <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.4" />
        <path
          className="pr-map-draw"
          pathLength={1}
          d="M5.2 8.2l2 2 3.8-4.2"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }
  const MergedIcon = PULL_REQUEST_STATE_PRESENTATION.merged.Icon;
  return (
    <MergedIcon
      aria-hidden
      className={cn("mt-0.5 size-4 shrink-0", PULL_REQUEST_STATE_PRESENTATION.merged.toneClassName)}
    />
  );
}

function PrFlowAction({
  flow,
  onResolveConflicts,
  onMerge,
}: {
  flow: PrFlow;
  onResolveConflicts?: (() => void) | undefined;
  onMerge?: (() => void) | undefined;
}) {
  switch (flow.phase) {
    case "conflicts":
      if (onResolveConflicts === undefined) return null;
      return (
        <Button key="resolve" size="xs" onClick={onResolveConflicts}>
          Resolve conflicts
        </Button>
      );
    case "ready":
      // A draft or a pull request with failing checks waits on the reader, not on Merge.
      if (flow.draft || flow.checksFailed || onMerge === undefined) return null;
      return (
        <Button key="merge" size="xs" onClick={onMerge}>
          Merge
        </Button>
      );
    case "resolving":
    case "merging":
      return (
        <Button key={flow.phase} size="xs" variant="ghost" disabled>
          <LoaderCircleIcon aria-hidden className="animate-spin" />
          {flow.phase === "resolving" ? "Resolving" : "Merging"}
        </Button>
      );
    default:
      return null;
  }
}
