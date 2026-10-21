import { createFileRoute, notFound } from "@tanstack/react-router";
import { useState } from "react";

import { PrFlowCard, ShimmerLabel } from "~/components/chat/prFlow/PrFlowCard";
import { type ReviewAgent, ReviewCard } from "~/components/chat/ReviewProgress";
import { Button } from "~/components/ui/button";
import { ThreadId } from "@t3tools/contracts";
import type { PrFlow } from "@t3tools/client-runtime/pr-flow";

/**
 * Development preview of the Review panel's top: the compact pull request card and the review
 * card under it, through a deep review's agents arriving and settling. Not in production builds.
 */
export const Route = createFileRoute("/dev/review")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: ReviewPreview,
});

const flow: PrFlow = {
  phase: "ready",
  title: "feat(playbooks): MGAI-1120 wait for External API Call results through callbacks",
  number: 1615,
  url: "https://github.com/example/agents/pull/1615",
  head: "feat/playbook-http-callback-steps",
  base: "main",
  additions: 2139,
  deletions: 63,
  mergedAt: null,
  draft: false,
  reviewDecision: "review-required",
  rows: [],
  headCommits: 4,
  conflicts: null,
  checks: null,
  step: null,
};

const agent = (id: string, name: string, status: ReviewAgent["status"]): ReviewAgent => ({
  id: ThreadId.make(id),
  name,
  status,
});

const STAGES: ReadonlyArray<{ label: string; step: string; agents: ReadonlyArray<ReviewAgent> }> = [
  { label: "Starting", step: "Reading agents/playbooks/actions.py", agents: [] },
  {
    label: "Two lenses",
    step: "Reading agents/playbooks/callback.py",
    agents: [agent("a1", "Correctness lens", "running"), agent("a2", "Security lens", "running")],
  },
  {
    label: "Three lenses",
    step: "Sent 2 findings so far",
    agents: [
      agent("a1", "Correctness lens", "done"),
      agent("a2", "Security lens", "running"),
      agent("a3", "Tests lens", "running"),
    ],
  },
  {
    label: "Many lenses",
    step: "Sent 5 findings so far",
    agents: [
      agent("a1", "Correctness lens", "done"),
      agent("a2", "Security lens", "done"),
      agent("a3", "Tests lens", "running"),
      agent("a4", "Performance lens", "failed"),
      agent("a5", "Docs lens", "queued"),
    ],
  },
];

function ReviewPreview() {
  const [stage, setStage] = useState(1);
  const [failed, setFailed] = useState(false);
  const [startedAt] = useState(() => new Date(Date.now() - 2 * 60_000).toISOString());
  const current = STAGES[stage]!;
  return (
    <div className="flex min-h-screen flex-col items-center gap-6 bg-background p-10">
      <div className="flex flex-wrap items-center gap-2">
        {STAGES.map((entry, index) => (
          <Button
            key={entry.label}
            variant={index === stage && !failed ? "default" : "outline"}
            size="xs"
            onClick={() => {
              setFailed(false);
              setStage(index);
            }}
          >
            {entry.label}
          </Button>
        ))}
        <Button variant={failed ? "default" : "outline"} size="xs" onClick={() => setFailed(true)}>
          Failed
        </Button>
      </div>
      <div className="flex w-90 flex-col border-border border-x bg-background pb-6">
        <div className="shrink-0 px-3 pt-3">
          <PrFlowCard flow={flow} compact onOpen={() => {}} />
        </div>
        <ReviewCard
          icon={null}
          mode="Deep review"
          model="Grok 4.7"
          startedAt={startedAt}
          state={
            failed
              ? {
                  kind: "failed",
                  text: "Review failed: the provider returned no answer · took 2 min",
                }
              : { kind: "running" }
          }
          step={
            <ShimmerLabel live text={current.step}>
              <span className="block truncate text-muted-foreground">{current.step}</span>
            </ShimmerLabel>
          }
          agents={current.agents}
          onViewAgent={() => {}}
          onStop={() => {}}
          stopping={false}
          onRetry={failed ? () => setFailed(false) : null}
          retrying={false}
        />
        <p className="flex items-baseline gap-2 border-border/60 border-b px-3 py-2 text-xs">
          <span className="min-w-0 flex-1 truncate">
            <span className="text-muted-foreground">Reviewing </span>
            <span className="font-medium">PR #1615</span>
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums">3 files</span>
        </p>
      </div>
    </div>
  );
}
