import type { GitGraphCommit, GitPullRequestGraph, PullRequestCheck } from "@t3tools/contracts";
import { createFileRoute, notFound } from "@tanstack/react-router";
import { useEffect, useState } from "react";

import { PrFlowCard } from "~/components/chat/prFlow/PrFlowCard";
import { PrFlowStatusChip } from "~/components/chat/prFlow/PrFlowStatusChip";
import {
  type PrFlow,
  type PrFlowPullRequest,
  type PrFlowSources,
  prFlowCreating,
  prFlowFromPullRequest,
} from "~/components/chat/prFlow/prFlowModel";
import { Button } from "~/components/ui/button";
import { observeChipGlide } from "~/lib/chipGlide";

/**
 * Development preview of the PR flow card: sample graphs and checks run through the same model
 * the chat uses, one step at a time. Not in production builds.
 */
export const Route = createFileRoute("/dev/pr-flow")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) throw notFound();
  },
  component: PrFlowPreview,
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const commit = (
  sha: string,
  subject: string,
  authorName: string,
  minutes: number,
  lane: GitGraphCommit["lane"],
  parents: ReadonlyArray<string>,
  refs: ReadonlyArray<string> = [],
): GitGraphCommit => ({
  sha: sha.padEnd(40, "0"),
  subject,
  authorName,
  authoredAt: minutesAgo(minutes),
  parents: parents.map((parent) => parent.padEnd(40, "0")),
  refs,
  lane,
});

const HEAD = [
  commit(
    "d29f50",
    "Add handoff retry tests",
    "You",
    0,
    "head",
    ["c70a92"],
    ["fix/provider-handoff"],
  ),
  commit("c70a92", "Retry the handoff once on timeout", "You", 25, "head", ["1f8e3b"]),
  commit("1f8e3b", "Read the provider timeout from settings", "You", 40, "head", ["9c2d4a"]),
];
const BASE = [
  commit("5be27d", "Read limits from the provider", "Mira", 6, "base", ["a3f9c1"], ["main"]),
  commit("a3f9c1", "Merge pull request #121 from feat/usage-banner", "Mira", 18, "base", [
    "9c2d4a",
    "e83c51",
  ]),
  commit("e83c51", "Add the usage banner", "Sam", 32, "side", ["62b0e4"], ["feat/usage-banner"]),
  commit("62b0e4", "Track usage events", "Sam", 120, "side", ["9c2d4a"]),
];
const FORK = commit("9c2d4a", "Bump effect to 4.0.5", "Sam", 180, "base", []);

const GRAPH: GitPullRequestGraph = {
  mergeBase: FORK.sha,
  head: HEAD,
  headTruncated: false,
  base: BASE,
  baseTruncated: false,
  fork: FORK,
  merged: false,
  conflicts: {
    truncated: false,
    files: [
      {
        path: "handoff.ts",
        count: 1,
        baseCommits: [BASE[0]!.sha],
        oursAuthor: "You",
        theirsAuthor: "Mira Chen",
        hunks: [
          {
            line: 18,
            theirs: ["const limits = await provider.limits();"],
            ours: ["if (timedOut(turn)) return retryOnce(turn);"],
          },
        ],
      },
      {
        path: "limits.ts",
        count: 2,
        baseCommits: [BASE[0]!.sha],
        oursAuthor: "You",
        theirsAuthor: "Mira Chen",
        hunks: [
          { line: 42, theirs: ["return limits.current;"], ours: ["return settings.timeoutMs;"] },
          { line: 57, theirs: ["const ttl = limits.ttl;"], ours: ["const ttl = DEFAULT_TTL;"] },
        ],
      },
    ],
  },
  resolving: null,
  viewerName: "You",
};

const check = (
  name: string,
  status: PullRequestCheck["status"],
  seconds: number,
): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: "https://example.invalid/checks",
  startedAt: minutesAgo(2),
  ...(status === "pending"
    ? {}
    : { completedAt: new Date(Date.now() - 120_000 + seconds * 1000).toISOString() }),
});

const passedChecks = () => [
  check("Tests", "success", 38),
  check("Lint", "success", 9),
  check("typecheck", "success", 21),
  check("Vercel Preview", "success", 64),
];

const PR: PrFlowPullRequest = {
  number: 128,
  url: "https://github.com/example/app/pull/128",
  title: "Retry the provider handoff on timeout",
  state: "open",
  headBranch: "fix/provider-handoff",
  baseBranch: "main",
  additions: 128,
  deletions: 36,
};
const IDLE: PrFlowSources = {
  graph: GRAPH,
  checks: null,
  resolveAsked: false,
  merging: false,
  command: null,
};
const RESOLVED_GRAPH: GitPullRequestGraph = {
  ...GRAPH,
  head: [
    commit(
      "7e0c3b",
      "Merge main into fix/provider-handoff",
      "You",
      0,
      "head",
      ["d29f50", "5be27d"],
      ["fix/provider-handoff"],
    ),
    ...HEAD.map((row) => ({ ...row, refs: [] })),
  ],
  base: BASE.map((row) => ({ ...row, inHead: true })),
  conflicts: { files: [], truncated: false },
};

const STEPS: ReadonlyArray<{ readonly name: string; readonly flow: () => PrFlow | null }> = [
  {
    name: "committing",
    flow: () =>
      prFlowCreating({
        title: PR.title,
        head: PR.headBranch,
        stepLabel: "Committing...",
        commitsToPush: null,
      }),
  },
  {
    name: "pushing",
    flow: () =>
      prFlowCreating({
        title: PR.title,
        head: PR.headBranch,
        stepLabel: "Pushing to origin...",
        commitsToPush: 3,
      }),
  },
  {
    name: "opening",
    flow: () =>
      prFlowCreating({
        title: PR.title,
        head: PR.headBranch,
        stepLabel: "Creating pull request...",
        commitsToPush: 3,
      }),
  },
  {
    name: "conflicts",
    flow: () => prFlowFromPullRequest({ ...PR, mergeability: "conflicting" }, IDLE),
  },
  {
    name: "fetching",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "conflicting" },
        { ...IDLE, resolveAsked: true, command: "git fetch origin main" },
      ),
  },
  {
    name: "resolving 1",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "conflicting" },
        {
          ...IDLE,
          resolveAsked: true,
          graph: { ...GRAPH, resolving: { total: 2, unresolved: ["handoff.ts", "limits.ts"] } },
        },
      ),
  },
  {
    name: "resolving 2",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "conflicting" },
        {
          ...IDLE,
          resolveAsked: true,
          graph: { ...GRAPH, resolving: { total: 2, unresolved: ["limits.ts"] } },
        },
      ),
  },
  {
    name: "pushing merge",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "conflicting" },
        { ...IDLE, resolveAsked: true, graph: RESOLVED_GRAPH, command: "git push" },
      ),
  },
  {
    name: "testing",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "mergeable", checksState: "pending" },
        {
          ...IDLE,
          graph: RESOLVED_GRAPH,
          checks: [
            check("Tests", "pending", 0),
            check("Lint", "success", 9),
            check("typecheck", "pending", 0),
            check("Vercel Preview", "success", 64),
          ],
        },
      ),
  },
  {
    name: "ready",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "mergeable", checksState: "passing" },
        {
          ...IDLE,
          graph: RESOLVED_GRAPH,
          checks: passedChecks(),
        },
      ),
  },
  {
    name: "merging",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, mergeability: "mergeable", checksState: "passing" },
        { ...IDLE, graph: RESOLVED_GRAPH, merging: true, checks: passedChecks() },
      ),
  },
  {
    name: "merged",
    flow: () =>
      prFlowFromPullRequest(
        { ...PR, state: "merged" },
        {
          ...IDLE,
          graph: { ...RESOLVED_GRAPH, merged: true },
          checks: passedChecks(),
        },
      ),
  },
];

function PrFlowPreview() {
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(true);
  useEffect(() => {
    if (!playing) return;
    const timer = window.setTimeout(() => {
      if (index + 1 < STEPS.length) setIndex(index + 1);
      else setPlaying(false);
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [index, playing]);
  const flow = STEPS[index]?.flow() ?? null;

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      <div className="flex flex-wrap items-center gap-1.5 border-b px-4 py-2">
        <span className="mr-2 text-sm font-medium">PR flow preview</span>
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setIndex(0);
            setPlaying(true);
          }}
        >
          Replay
        </Button>
        {STEPS.map((step, stepIndex) => (
          <Button
            key={step.name}
            size="xs"
            variant={stepIndex === index ? "secondary" : "ghost"}
            onClick={() => {
              setPlaying(false);
              setIndex(stepIndex);
            }}
          >
            {step.name}
          </Button>
        ))}
      </div>
      <div className="scrollbar-gutter-both flex min-h-0 flex-1 flex-col justify-end overflow-y-auto px-6 py-4">
        <div className="mx-auto flex w-full max-w-170 flex-col gap-3.5 text-sm">
          {flow ? (
            <PrFlowCard
              flow={flow}
              onResolveConflicts={() => setIndex(4)}
              onMerge={() => setIndex(STEPS.length - 2)}
              onOpen={(url) => window.open(url, "_blank", "noopener")}
            />
          ) : null}
        </div>
      </div>
      <div className="px-6 pb-5">
        <div className="mx-auto flex w-full max-w-170 flex-col gap-2">
          <div ref={observeChipGlide} className="relative flex gap-1.5">
            {flow ? <PrFlowStatusChip flow={flow} /> : null}
            <span className="flex h-6.5 items-center gap-1.5 rounded-full border bg-card px-2.5 font-mono text-xs">
              <span className="text-diff-addition-foreground">+{PR.additions}</span>
              <span className="text-diff-deletion-foreground">−{PR.deletions}</span>
            </span>
          </div>
          <div className="rounded-2xl border bg-card px-3 py-3 text-muted-foreground">
            Ask anything, or type / for skills
          </div>
        </div>
      </div>
    </div>
  );
}
