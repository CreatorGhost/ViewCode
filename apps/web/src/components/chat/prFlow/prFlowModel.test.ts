import type { GitGraphCommit, GitPullRequestGraph, PullRequestCheck } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type PrFlowActivitySource,
  type PrFlowSources,
  prFlowAwaitingReview,
  prFlowCommandStep,
  prFlowCreating,
  prFlowCreatingPhase,
  prFlowFromPullRequest,
  prFlowGitCommandsKey,
  prFlowResolvePrompt,
  prFlowResolvingNumber,
  prFlowRunningCommand,
  prFlowStatus,
} from "./prFlowModel";

const OPEN = {
  number: 128,
  url: "https://github.com/acme/app/pull/128",
  title: "Refresh sessions in the auth middleware",
  state: "open",
  headBranch: "feat/session-refresh",
  baseBranch: "main",
  additions: 482,
  deletions: 37,
} as const;

const commit = (
  sha: string,
  subject: string,
  authorName: string,
  authoredAt: string,
  lane: GitGraphCommit["lane"],
  parents: ReadonlyArray<string> = [],
): GitGraphCommit => ({ sha, subject, authorName, authoredAt, parents, refs: [], lane });

const GRAPH: GitPullRequestGraph = {
  mergeBase: "fork",
  head: [
    commit("tests", "Add session refresh tests", "Ada", "2026-10-19T10:00:00Z", "head", ["near"]),
    commit("near", "Refresh sessions near expiry", "Ada", "2026-10-19T09:35:00Z", "head", ["fork"]),
  ],
  headTruncated: false,
  base: [
    commit(
      "keys",
      "Read sessions with the current key",
      "Lena Park",
      "2026-10-19T09:54:00Z",
      "base",
      ["rotate"],
    ),
    commit("rotate", "Rotate session keys", "Lena Park", "2026-10-19T09:42:00Z", "base", ["fork"]),
  ],
  baseTruncated: false,
  fork: commit("fork", "Bump next to 16.3", "Sam", "2026-10-19T07:00:00Z", "base"),
  merged: false,
  conflicts: {
    truncated: false,
    files: [
      {
        path: "middleware.ts",
        count: 1,
        baseCommits: ["keys"],
        oursAuthor: "Ada",
        theirsAuthor: "Lena Park",
        hunks: [{ line: 18, ours: ["refresh()"], theirs: ["readSession()"] }],
      },
      {
        path: "auth.ts",
        count: 2,
        baseCommits: ["rotate"],
        oursAuthor: "Ada",
        theirsAuthor: "Lena Park",
        hunks: [],
      },
    ],
  },
  resolving: null,
  viewerName: "Ada",
};

const IDLE: PrFlowSources = {
  graph: null,
  checks: null,
  resolveAsked: false,
  merging: false,
  command: null,
};

const check = (name: string, status: PullRequestCheck["status"]): PullRequestCheck => ({
  name,
  status,
  description: null,
  url: null,
});

describe("prFlowCreating", () => {
  it("follows the git menu's steps while it opens a pull request", () => {
    expect(prFlowCreatingPhase(null)).toBe("committing");
    expect(prFlowCreatingPhase("Generating commit message...")).toBe("committing");
    expect(prFlowCreatingPhase("Pushing to origin...")).toBe("pushing");
    expect(prFlowCreatingPhase("Generating PR content...")).toBe("opening");
    expect(prFlowCreatingPhase("Creating merge request...")).toBe("opening");

    const creating = (stepLabel: string | null, commitsToPush: number | null) =>
      prFlowStatus(prFlowCreating({ title: "t", head: "h", stepLabel, commitsToPush }));
    expect(creating("Committing...", null)).toMatchObject({
      tone: "busy",
      label: "Committing the last changes",
      short: "Creating PR",
    });
    expect(creating("Pushing to origin...", 3).label).toBe("Pushing 3 commits to origin");
    expect(creating("Pushing to origin...", null).label).toBe("Pushing to origin");
    expect(creating("Creating pull request...", 3).label).toBe("Opening the pull request");
  });
});

describe("prFlowFromPullRequest", () => {
  it("shows where it conflicts, from the checkout, with the clashes on the base commits that brought them", () => {
    const flow = prFlowFromPullRequest(
      { ...OPEN, mergeability: "conflicting" },
      { ...IDLE, graph: GRAPH },
    );
    expect(flow?.phase).toBe("conflicts");
    expect(flow && prFlowStatus(flow)).toMatchObject({
      tone: "warning",
      label: "3 conflicts with main",
      short: "3 conflicts",
      target: "3 conflicts",
    });
    expect(
      flow?.rows.map((row) =>
        row.kind === "commit" ? [row.subject, row.author, row.lane, row.conflicts] : [row.kind],
      ),
    ).toEqual([
      ["Add session refresh tests", "You", "head", 0],
      ["Read sessions with the current key", "Lena Park", "base", 1],
      ["Rotate session keys", "Lena Park", "base", 2],
      ["Refresh sessions near expiry", "You", "head", 0],
      ["Bump next to 16.3", "Sam", "base", 0],
    ]);
    expect(flow?.conflicts?.files.map((file) => [file.path, file.oursAuthor])).toEqual([
      ["middleware.ts", "You"],
      ["auth.ts", "You"],
    ]);
  });

  it("says only that it conflicts when the checkout cannot say where", () => {
    const flow = prFlowFromPullRequest({ ...OPEN, mergeability: "conflicting" }, IDLE);
    expect(flow && prFlowStatus(flow).label).toBe("Conflicts with main");
  });

  it("trusts the host over a stale checkout once the host says it merges cleanly", () => {
    const flow = prFlowFromPullRequest(
      { ...OPEN, mergeability: "mergeable", checksState: "passing" },
      { ...IDLE, graph: GRAPH },
    );
    expect(flow?.phase).toBe("ready");
    expect(flow?.conflicts).toBeNull();
  });

  it("resolves conflict n of m as the agent fixes each file in the merge", () => {
    const pr = { ...OPEN, mergeability: "conflicting" } as const;
    const asked = { ...IDLE, resolveAsked: true };
    // Asked, the merge not started yet: the agent is working.
    const started = prFlowFromPullRequest(pr, { ...asked, graph: GRAPH });
    expect(started?.phase).toBe("resolving");
    expect(started && prFlowStatus(started)).toMatchObject({
      label: "Resolving conflict 1 of 3",
      short: "Resolving",
      target: "3 conflicts",
    });

    const merging = { total: 2, unresolved: ["auth.ts"] };
    const halfway = prFlowFromPullRequest(pr, {
      ...IDLE,
      graph: { ...GRAPH, resolving: merging },
    });
    expect(halfway?.phase).toBe("resolving");
    expect(halfway && prFlowStatus(halfway)).toMatchObject({
      label: "Resolving conflict 2 of 3",
      target: "2 conflicts",
    });
    // The merge row, the header and the footer count the same thing: clashes, not files.
    expect(halfway?.rows[0]).toMatchObject({ kind: "merging", done: 1, total: 3 });
    expect(
      halfway?.rows.flatMap((row) =>
        row.kind === "commit" && row.lane === "base"
          ? [[row.sha, row.resolved, row.conflicts]]
          : [],
      ),
    ).toEqual([
      ["keys", true, 0],
      ["rotate", false, 2],
      ["fork", false, 0],
    ]);

    const done = prFlowFromPullRequest(pr, {
      ...IDLE,
      graph: { ...GRAPH, resolving: { total: 2, unresolved: [] } },
    });
    expect(done && prFlowStatus(done)).toMatchObject({ label: "Working…", target: "resolved" });
  });

  it("counts files when the checkout cannot say where the clashes are", () => {
    const flow = prFlowFromPullRequest(
      { ...OPEN, mergeability: "conflicting" },
      {
        ...IDLE,
        graph: {
          ...GRAPH,
          conflicts: null,
          resolving: { total: 3, unresolved: ["a.ts", "b.ts"] },
        },
      },
    );
    expect(flow && prFlowStatus(flow)).toMatchObject({
      label: "Resolving file 2 of 3",
      target: "2 files",
    });
    expect(flow?.rows[0]).toMatchObject({ kind: "merging", done: 1, total: 3 });
  });

  it("names what the agent is running while it resolves", () => {
    const pr = { ...OPEN, mergeability: "conflicting" } as const;
    const flow = (command: string) =>
      prFlowFromPullRequest(pr, { ...IDLE, resolveAsked: true, command });
    expect(flow("git fetch origin main")?.step).toBe("Fetching main");
    expect(flow("git merge origin/main")?.step).toBe("Merging main into feat/session-refresh");
    expect(flow("git push")?.step).toBe("Pushing to origin");
    expect(flow("pnpm vitest run src/auth")?.step).toBe("Running tests");
    const unknown = flow("cat middleware.ts");
    expect(unknown?.step).toBeNull();
    expect(unknown && prFlowStatus(unknown).label).toBe("Working…");
    // Not resolving: the step line stays on the pull request's own state.
    expect(prFlowFromPullRequest(pr, { ...IDLE, command: "git push" })?.step).toBeNull();
  });

  it("counts finished checks while they run, then is ready to merge", () => {
    const running = prFlowFromPullRequest(
      { ...OPEN, mergeability: "mergeable", checksState: "pending" },
      {
        ...IDLE,
        checks: [
          check("Tests", "pending"),
          check("Lint", "success"),
          check("typecheck", "pending"),
        ],
      },
    );
    expect(running?.phase).toBe("testing");
    expect(running && prFlowStatus(running)).toMatchObject({
      tone: "busy",
      label: "Running checks, 1 of 3 done",
      short: "Running checks",
    });
    expect(running?.checks?.list.map((entry) => [entry.name, entry.state])).toEqual([
      ["Tests", "running"],
      ["Lint", "passed"],
      ["typecheck", "running"],
    ]);

    const ready = prFlowFromPullRequest(
      { ...OPEN, mergeability: "mergeable", checksState: "passing" },
      { ...IDLE, checks: [check("Tests", "success"), check("Vercel Preview", "skipped")] },
    );
    expect(ready?.phase).toBe("ready");
    expect(ready && prFlowStatus(ready)).toMatchObject({
      tone: "success",
      label: "Ready to merge",
    });
  });

  it("holds back Merge for failing checks and drafts", () => {
    const failing = prFlowFromPullRequest(
      { ...OPEN, checksState: "failing" },
      { ...IDLE, checks: [check("Tests", "failure"), check("Lint", "cancelled")] },
    );
    expect(failing && prFlowStatus(failing)).toMatchObject({
      tone: "warning",
      label: "2 checks failed",
    });
    const draft = prFlowFromPullRequest({ ...OPEN, isDraft: true }, IDLE);
    expect(draft && prFlowStatus(draft).label).toBe("Draft, no conflicts");
  });

  it("says a pull request waiting on review is not ready to merge", () => {
    const passing = { ...OPEN, mergeability: "mergeable", checksState: "passing" } as const;
    const pending = prFlowFromPullRequest({ ...passing, reviewDecision: "review-required" }, IDLE);
    expect(pending && prFlowStatus(pending)).toMatchObject({
      tone: "warning",
      label: "Review pending",
      short: "Review pending",
    });
    expect(pending && prFlowAwaitingReview(pending)).toBe(true);
    const changes = prFlowFromPullRequest(
      { ...passing, reviewDecision: "changes-requested" },
      IDLE,
    );
    expect(changes && prFlowStatus(changes).label).toBe("Changes requested");
    const approved = prFlowFromPullRequest({ ...passing, reviewDecision: "approved" }, IDLE);
    expect(approved && prFlowStatus(approved).label).toBe("Ready to merge");
    expect(approved && prFlowAwaitingReview(approved)).toBe(false);
  });

  it("merges, then stays merged", () => {
    const merging = prFlowFromPullRequest(OPEN, { ...IDLE, merging: true });
    expect(merging && prFlowStatus(merging)).toMatchObject({
      label: "Merging into main",
      short: "Merging",
    });
    const merged = prFlowFromPullRequest(
      { ...OPEN, state: "merged" },
      { ...IDLE, graph: { ...GRAPH, merged: true } },
    );
    expect(merged?.phase).toBe("merged");
    expect(merged && prFlowStatus(merged)).toMatchObject({
      tone: "merged",
      label: "Merged into main",
      target: "merged",
    });
    expect(merged?.conflicts).toBeNull();
  });

  it("has nothing to show for a closed pull request", () => {
    expect(prFlowFromPullRequest({ ...OPEN, state: "closed" }, IDLE)).toBeNull();
  });
});

describe("prFlowCommandStep", () => {
  it("leaves other git subcommands and lookalikes alone", () => {
    expect(prFlowCommandStep("git merge-base HEAD main", "main", "h")).toBeNull();
    expect(prFlowCommandStep("git -C repo fetch", "main", "h")).toBe("Fetching main");
    expect(prFlowCommandStep("bash -lc 'npm test'", "main", "h")).toBe("Running tests");
  });
});

describe("thread activity", () => {
  const prompt = prFlowResolvePrompt({ number: 128, base: "main", head: "feat/session-refresh" });
  const source = (
    runStatus: string,
    items: PrFlowActivitySource["turnItems"],
  ): PrFlowActivitySource => ({
    runs: [
      { id: "r1", status: "completed", ordinal: 1 },
      { id: "r2", status: runStatus, ordinal: 2 },
    ],
    turnItems: items,
  });
  const userMessage = (text: string) => ({
    type: "user_message",
    text,
    runId: "r2",
    status: "completed",
  });
  const command = (input: string, status: string) => ({
    type: "command_execution",
    input,
    status,
    runId: "r2",
  });

  it("is resolving while the run the Resolve prompt started is going, here or after a reload", () => {
    expect(prFlowResolvingNumber(source("running", [userMessage(prompt)]))).toBe(128);
    expect(prFlowResolvingNumber(source("completed", [userMessage(prompt)]))).toBeNull();
    expect(
      prFlowResolvingNumber(source("running", [userMessage(prompt), userMessage("thanks")])),
    ).toBeNull();
  });

  it("reads the running command, and keys refetches on finished git commands", () => {
    const items = [
      command("git fetch origin", "completed"),
      command("ls", "completed"),
      command("git merge origin/main", "running"),
    ];
    expect(prFlowRunningCommand(source("running", items))).toBe("git merge origin/main");
    expect(prFlowRunningCommand(source("completed", items))).toBeNull();
    expect(prFlowGitCommandsKey(source("running", items))).toBe("r2:1");
    expect(
      prFlowGitCommandsKey(
        source("running", [...items.slice(0, 2), command("git merge origin/main", "failed")]),
      ),
    ).toBe("r2:2");
  });
});
