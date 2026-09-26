import { memo, useEffect, useId, useRef } from "react";
import { CheckIcon, ChevronDownIcon, CircleAlertIcon, SquareIcon } from "lucide-react";
import {
  formatSubagentTokenCount,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { observeVisibleAnimation } from "~/lib/visibleAnimation";
import { cn } from "~/lib/utils";
import { deriveSubagentCard, deriveSubagentElapsedMs } from "./subagentCard.logic";

/** Ticks only the time label, so progress lists and the transcript stay still. */
function SubagentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const ref = useRef<HTMLSpanElement>(null);
  const { status, startedAt, firstSeenAt, completedAt, updatedAt } = agent;
  const live = status === "pending" || status === "running" || status === "waiting";
  const timing = { status, startedAt, firstSeenAt, completedAt, updatedAt };
  const elapsed = deriveSubagentElapsedMs(timing, Date.parse(updatedAt));

  useEffect(() => {
    const timing = { status, startedAt, firstSeenAt, completedAt, updatedAt };
    let timer: ReturnType<typeof setInterval> | undefined;
    const update = () => {
      const elapsed = deriveSubagentElapsedMs(timing, Date.now());
      if (ref.current) ref.current.textContent = elapsed === null ? "" : formatDuration(elapsed);
    };
    update();
    if (!live) return;
    const sync = () => {
      clearInterval(timer);
      if (document.visibilityState === "visible") {
        update();
        timer = setInterval(update, 1000);
      }
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", sync);
    };
  }, [live, status, startedAt, firstSeenAt, completedAt, updatedAt]);

  return (
    <span ref={ref} className="shrink-0 font-mono text-xs tabular-nums text-muted-foreground">
      {elapsed === null ? "" : formatDuration(elapsed)}
    </span>
  );
}

function SubagentIndicator({ status }: { status: RuntimeSubagent["status"] }) {
  if (status === "completed") return <CheckIcon aria-hidden className="size-4 text-success" />;
  if (status === "failed")
    return <CircleAlertIcon aria-hidden className="size-4 text-destructive" />;
  if (status !== "running" && status !== "pending") {
    return <SquareIcon aria-hidden className="size-4 text-muted-foreground" />;
  }
  return (
    <svg
      ref={observeVisibleAnimation}
      aria-hidden
      viewBox="0 0 20 20"
      fill="currentColor"
      className="size-4 text-info motion-safe:visible-animate-spin"
    >
      <rect x="2" y="2" width="5" height="5" />
      <rect x="9" y="2" width="5" height="5" opacity=".75" />
      <rect x="13" y="9" width="5" height="5" opacity=".5" />
      <rect x="6" y="13" width="5" height="5" opacity=".3" />
    </svg>
  );
}

/** One persistent identity, with a compact live preview and selectable details. */
export const SubagentCard = memo(function SubagentCard({
  agent,
  expanded,
  onToggle,
}: {
  agent: RuntimeSubagent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const bodyId = useId();
  const card = deriveSubagentCard(agent, Date.parse(agent.updatedAt));
  const running = agent.status === "running" || agent.status === "pending";
  const preview = card.latestActivity ?? card.statusLabel;
  const metadata = [
    card.modelLabel,
    agent.usage && agent.usage.totalTokens > 0
      ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tokens`
      : null,
  ].filter(Boolean);

  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border/80 bg-card/30">
      <button
        type="button"
        aria-expanded={expanded}
        aria-controls={bodyId}
        onClick={onToggle}
        className="flex w-full min-w-0 cursor-pointer flex-col gap-1.5 px-3 py-2.5 text-left hover:bg-accent/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <span className="flex size-5 shrink-0 items-center justify-center">
            <SubagentIndicator status={agent.status} />
          </span>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {agent.title}
          </span>
          <SubagentElapsed agent={agent} />
          <span
            className={cn(
              "flex shrink-0 items-center gap-1.5 text-xs",
              agent.status === "failed" ? "text-destructive" : "text-muted-foreground",
            )}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                running || agent.status === "completed"
                  ? "bg-success"
                  : agent.status === "failed"
                    ? "bg-destructive"
                    : "bg-muted-foreground/60",
              )}
            />
            {card.statusLabel}
          </span>
          <ChevronDownIcon
            aria-hidden
            className={cn("size-3.5 shrink-0 text-muted-foreground", expanded && "rotate-180")}
          />
        </span>
        <span className="ms-2.5 flex w-[calc(100%-0.625rem)] min-w-0 items-start gap-2 text-xs text-muted-foreground">
          <span
            aria-hidden
            className="mt-0.5 h-3 w-2 shrink-0 rounded-bl border-b border-l border-border"
          />
          <span className="truncate font-mono">{preview}</span>
        </span>
      </button>
      {expanded ? (
        <div
          id={bodyId}
          className="flex max-h-72 cursor-text select-text flex-col gap-3 overflow-auto border-t border-border/60 bg-muted/20 px-3 py-3 text-xs"
        >
          <div>
            <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Task
            </p>
            <p className="whitespace-pre-wrap break-words text-foreground/90">{agent.title}</p>
            {agent.role && agent.role !== agent.title ? (
              <p className="mt-1 text-muted-foreground">{agent.role}</p>
            ) : null}
          </div>
          <div>
            <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
              Recent progress
            </p>
            {card.history.length > 0 ? (
              <ol className="flex flex-col gap-1.5">
                {card.history.map((entry, index) => (
                  <li key={entry.id} className="flex min-w-0 items-start gap-2">
                    <span
                      aria-hidden
                      className={cn(
                        "mt-1.5 size-1 shrink-0 rounded-full",
                        running && index === card.history.length - 1
                          ? "bg-info"
                          : "bg-muted-foreground/50",
                      )}
                    />
                    <span className="whitespace-pre-wrap break-words font-mono text-muted-foreground">
                      {entry.summary}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-muted-foreground">No progress details reported yet.</p>
            )}
          </div>
          {card.error ? (
            <div>
              <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-destructive">
                Error
              </p>
              <p className="whitespace-pre-wrap break-words text-foreground/90">{card.error}</p>
            </div>
          ) : null}
          {card.result ? (
            <div>
              <p className="mb-1 text-2xs font-medium uppercase tracking-wide text-muted-foreground">
                Result
              </p>
              <p className="whitespace-pre-wrap break-words text-foreground/90">{card.result}</p>
            </div>
          ) : null}
          {metadata.length > 0 ? (
            <p className="border-t border-border/60 pt-2 font-mono text-2xs text-muted-foreground">
              {metadata.join(" · ")}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
});
