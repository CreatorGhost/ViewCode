import { createFileRoute, notFound } from "@tanstack/react-router";
import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { PrFlowCard } from "~/components/chat/prFlow/PrFlowCard";
import { PrFlowStatusChip } from "~/components/chat/prFlow/PrFlowStatusChip";
import {
  type PrFlow,
  type PrFlowPhase,
  PR_FLOW_PHASES,
  prFlowReached,
  prFlowStatus,
} from "~/components/chat/prFlow/prFlowModel";
import { Button } from "~/components/ui/button";
import { observeChipGlide } from "~/lib/chipGlide";

/** Development preview of the PR flow card, played through every state. Not in production builds. */
export const Route = createFileRoute("/dev/pr-flow")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PrFlowPreview,
});

const BASE_FLOW: PrFlow = {
  phase: "committing",
  title: "Retry the provider handoff on timeout",
  number: 128,
  head: "fix/provider-handoff",
  base: "main",
  commitCount: 3,
  additions: 128,
  deletions: 36,
  conflicts: {
    author: "Mira",
    files: [
      { path: "handoff.ts", count: 1 },
      { path: "limits.ts", count: 2 },
    ],
    resolved: 0,
  },
  tests: { passed: 0, total: 42 },
};

type Step = { at: number; phase: PrFlowPhase; resolved?: number; passed?: number };

function buildSteps(): ReadonlyArray<Step> {
  const steps: Step[] = [];
  let at = 600;
  const push = (gap: number, step: Omit<Step, "at">) => {
    at += gap;
    steps.push({ at, ...step });
  };
  push(0, { phase: "committing" });
  push(1500, { phase: "pushing" });
  push(1200, { phase: "opening" });
  push(1100, { phase: "fetching" });
  push(1000, { phase: "checking" });
  push(1100, { phase: "conflicts" });
  push(2600, { phase: "resolving", resolved: 0 });
  push(900, { phase: "resolving", resolved: 1 });
  push(800, { phase: "resolving", resolved: 2 });
  push(700, { phase: "testing", passed: 0 });
  for (let passed = 2; passed <= 42; passed += 2) push(55, { phase: "testing", passed });
  push(300, { phase: "ready", passed: 42 });
  push(2600, { phase: "merging", passed: 42 });
  push(1100, { phase: "merged", passed: 42 });
  return steps;
}

const STEPS = buildSteps();

function flowAt(step: Step | undefined): PrFlow | null {
  if (!step) return null;
  return {
    ...BASE_FLOW,
    phase: step.phase,
    commitCount: step.phase === "merged" ? 4 : BASE_FLOW.commitCount,
    conflicts: BASE_FLOW.conflicts && {
      ...BASE_FLOW.conflicts,
      resolved: step.resolved ?? 0,
    },
    tests: { passed: step.passed ?? 0, total: 42 },
  };
}

function PrFlowPreview() {
  // A positive run plays the whole flow; jumping to a state pauses on it.
  const [run, setRun] = useState(1);
  const [index, setIndex] = useState(-1);
  useEffect(() => {
    if (run <= 0) return;
    const timers = STEPS.map((step, stepIndex) =>
      window.setTimeout(() => setIndex(stepIndex), step.at),
    );
    return () => timers.forEach(window.clearTimeout);
  }, [run]);

  const flow = flowAt(STEPS[index]);
  const reached = (phase: PrFlowPhase) => flow !== null && prFlowReached(flow.phase, phase);
  const jump = (phase: PrFlowPhase) => {
    let target = -1;
    STEPS.forEach((step, stepIndex) => {
      if (step.phase === phase) target = stepIndex;
    });
    setRun((current) => -Math.abs(current));
    setIndex(target);
  };

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <span className="mr-2 text-sm font-medium">PR flow preview</span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setIndex(-1);
            setRun((current) => Math.abs(current) + 1);
          }}
        >
          Replay
        </Button>
        {PR_FLOW_PHASES.map((phase) => (
          <Button
            key={phase}
            size="xs"
            variant={flow?.phase === phase ? "secondary" : "ghost"}
            onClick={() => jump(phase)}
          >
            {phase}
          </Button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden px-6 py-4">
        <div className="mx-auto flex w-full max-w-170 flex-col gap-3.5 text-sm">
          <div className="self-end rounded-xl border bg-muted/60 px-3 py-1.5">
            Provider handoff fails when Claude times out. Can you fix that?
          </div>
          <ActivityLine label="Thought for 14s" />
          <p className="leading-relaxed text-secondary-label">
            Done. The handoff now retries once when a provider times out, so you don't lose the turn
            mid-switch. I added tests for both paths.
          </p>
          {flow ? (
            <>
              <div className="blur-swap self-end rounded-xl border bg-muted/60 px-3 py-1.5">
                Create PR
              </div>
              <ActivityLine
                key={reached("conflicts") ? "done" : flow.phase}
                label={reached("conflicts") ? "Worked for 5s" : prFlowStatus(flow).label}
                live={!reached("conflicts")}
              />
              <PrFlowCard
                flow={flow}
                onResolveConflicts={() => jump("resolving")}
                onMerge={() => jump("merging")}
              />
            </>
          ) : null}
          {reached("conflicts") ? (
            <p className="blur-swap leading-relaxed text-secondary-label">
              PR #128 is open, but main moved on while we worked: Mira's provider-limits change
              touched the same lines in handoff.ts and limits.ts. I can merge main in and resolve
              them.
            </p>
          ) : null}
          {reached("resolving") ? (
            <div className="blur-swap self-end rounded-xl border bg-muted/60 px-3 py-1.5">
              Resolve conflicts
            </div>
          ) : null}
          {reached("ready") ? (
            <p className="blur-swap leading-relaxed text-secondary-label">
              Done. I kept Mira's limits change and moved the retry after it, so a retried turn
              reads the new limits. All 42 tests pass, and #128 is ready to merge.
            </p>
          ) : null}
        </div>
      </div>
      <div className="px-6 pb-5">
        <div className="mx-auto flex w-full max-w-170 flex-col gap-2">
          <div ref={observeChipGlide} className="relative flex justify-end gap-1.5">
            <span className="flex h-6.5 items-center gap-1.5 rounded-full border bg-card px-2.5 font-mono text-xs">
              4 files <span className="text-diff-addition-foreground">+128</span>
              <span className="text-diff-deletion-foreground">−36</span>
            </span>
            {flow ? <PrFlowStatusChip flow={flow} /> : null}
          </div>
          <div className="rounded-2xl border bg-card px-3 py-3 text-muted-foreground">
            Ask anything, or type / for skills
          </div>
        </div>
      </div>
    </div>
  );
}

function ActivityLine({ label, live = false }: { label: string; live?: boolean }) {
  return (
    <div className="blur-swap flex items-center gap-1.5 text-row text-muted-foreground">
      <ChevronRightIcon aria-hidden className="size-3.5" />
      <span className={live ? "live-tool-shine" : undefined}>{label}</span>
    </div>
  );
}
