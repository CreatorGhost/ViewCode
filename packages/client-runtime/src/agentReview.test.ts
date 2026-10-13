import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadPullRequestLink,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  localReviewDiffRequest,
  reviewedChangeLabel,
  reviewNoChangesText,
  reviewStopPlan,
  type AgentReviewChanges,
  agentReviewRetryRequest,
  agentReviewTargetChoices,
  agentReviewTargetLabel,
  agentReviewTargetRequest,
  buildAgentReviewStart,
  canChooseLocalReviewScope,
  filterReviewCommits,
  formatReviewDuration,
  inferAgentReviewTarget,
  formatReviewElapsed,
  localReviewScopeLabel,
  pastedReviewCommitSha,
  reviewFindingsSentText,
  reviewStatusText,
  shortReviewError,
} from "./agentReview.ts";

const PROJECT_ID = ProjectId.make("project");
const CHAT = ThreadId.make("chat");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1" };

describe("buildAgentReviewStart", () => {
  it("starts a pull request review as the asking chat's agent, leaving out empty choices", () => {
    expect(
      buildAgentReviewStart(
        {
          kind: "pull-request",
          reference: { projectId: PROJECT_ID, repository: "acme/web", number: 7 },
          sourceThreadId: CHAT,
        },
        { mode: "deep", modelSelection: MODEL, focus: "  ", scope: { kind: "uncommitted" } },
        { canScope: true },
      ),
    ).toEqual({
      method: "pullRequests.startReview",
      input: {
        projectId: PROJECT_ID,
        repository: "acme/web",
        number: 7,
        mode: "deep",
        modelSelection: MODEL,
        sourceThreadId: CHAT,
      },
    });
  });

  it("sends what to read of local changes only to a server that reads it", () => {
    const request = { kind: "local", projectId: PROJECT_ID, sourceThreadId: CHAT } as const;
    const choices = {
      mode: "quick",
      modelSelection: null,
      focus: " retries ",
      scope: { kind: "commit", sha: "abc1234" },
    } as const;
    expect(buildAgentReviewStart(request, choices, { canScope: true })).toEqual({
      method: "review.startLocal",
      input: {
        projectId: PROJECT_ID,
        mode: "quick",
        focus: "retries",
        sourceThreadId: CHAT,
        scope: { kind: "commit", sha: "abc1234" },
      },
    });
    // An older server would ignore it and review something else.
    expect(buildAgentReviewStart(request, choices, { canScope: false }).input).not.toHaveProperty(
      "scope",
    );
  });
});

describe("canChooseLocalReviewScope", () => {
  it("offers what to review only for local changes on a server that reads it", () => {
    const local = { kind: "local" } as const;
    expect(canChooseLocalReviewScope(local, { localAgentReviewScope: true })).toBe(true);
    // An older server would ignore the choice and review something else: hide it.
    expect(canChooseLocalReviewScope(local, {})).toBe(false);
    expect(canChooseLocalReviewScope(local, undefined)).toBe(false);
    // A pull request review reads the pull request.
    expect(
      canChooseLocalReviewScope({ kind: "pull-request" }, { localAgentReviewScope: true }),
    ).toBe(false);
  });
});

describe("local review scopes", () => {
  const request = { kind: "local", projectId: PROJECT_ID, sourceThreadId: CHAT } as const;
  const start = (scope: Parameters<typeof localReviewScopeLabel>[0]) =>
    buildAgentReviewStart(
      request,
      { mode: "quick", modelSelection: null, focus: "", scope },
      { canScope: true },
    ).input;

  it("sends each kind as asked, and nothing for the default", () => {
    expect(start(null)).not.toHaveProperty("scope");
    expect(start({ kind: "uncommitted" })).toMatchObject({ scope: { kind: "uncommitted" } });
    expect(start({ kind: "branch" })).toMatchObject({ scope: { kind: "branch" } });
    expect(start({ kind: "branch", base: "origin/release" })).toMatchObject({
      scope: { kind: "branch", base: "origin/release" },
    });
    expect(start({ kind: "commit", sha: "abc1234" })).toMatchObject({
      scope: { kind: "commit", sha: "abc1234" },
    });
  });

  it("names each kind in a few words", () => {
    expect(localReviewScopeLabel(null)).toBe("Uncommitted changes, else the branch");
    expect(localReviewScopeLabel({ kind: "uncommitted" })).toBe("Uncommitted changes");
    expect(localReviewScopeLabel({ kind: "branch", base: "origin/main" })).toBe(
      "Branch vs origin/main",
    );
    expect(localReviewScopeLabel({ kind: "commit", sha: "a1b2c3d4e5f6" })).toBe("Commit a1b2c3d");
  });

  it("finds commits by SHA prefix, subject or author, and takes a pasted SHA", () => {
    const commit = (sha: string, subject: string, author: string) => ({
      sha,
      shortSha: sha.slice(0, 7),
      subject,
      author,
      committedAt: "2026-10-01T10:00:00Z",
    });
    const commits = [
      commit("a1b2c3d4", "Fix the retry", "Ada"),
      commit("f6e5d4c3", "Cache", "Grace"),
    ];
    expect(filterReviewCommits(commits, "").map((entry) => entry.sha)).toEqual([
      "a1b2c3d4",
      "f6e5d4c3",
    ]);
    expect(filterReviewCommits(commits, "F6E").map((entry) => entry.sha)).toEqual(["f6e5d4c3"]);
    expect(filterReviewCommits(commits, "retry").map((entry) => entry.sha)).toEqual(["a1b2c3d4"]);
    expect(filterReviewCommits(commits, "grace").map((entry) => entry.sha)).toEqual(["f6e5d4c3"]);
    expect(pastedReviewCommitSha(" A1B2C3D ")).toBe("a1b2c3d");
    expect(pastedReviewCommitSha("a1b2c3")).toBeNull();
    expect(pastedReviewCommitSha("main")).toBeNull();
  });
});

describe("the change a review shows", () => {
  it("reads each scope's own diff", () => {
    expect(localReviewDiffRequest(null)).toEqual({ source: "auto" });
    expect(localReviewDiffRequest({ kind: "uncommitted" })).toEqual({ source: "working-tree" });
    expect(localReviewDiffRequest({ kind: "branch" })).toEqual({ source: "branch-range" });
    expect(localReviewDiffRequest({ kind: "branch", base: "origin/main" })).toEqual({
      baseRef: "origin/main",
      source: "branch-range",
    });
    expect(localReviewDiffRequest({ kind: "commit", sha: "7523ce0abc" })).toEqual({
      baseRef: "7523ce0abc^",
      headRef: "7523ce0abc",
      source: "branch-range",
    });
  });

  it("names it in the header", () => {
    const local = { kind: "local" } as const;
    expect(reviewedChangeLabel({ kind: "pull-request", number: 12 }, null, null)).toBe("PR #12");
    expect(reviewedChangeLabel(local, null, null)).toBe("Local changes");
    expect(reviewedChangeLabel(local, { kind: "branch" }, "origin/main")).toBe(
      "Branch vs origin/main",
    );
    expect(reviewedChangeLabel(local, { kind: "branch", base: "release" }, "origin/main")).toBe(
      "Branch vs release",
    );
    expect(reviewedChangeLabel(local, { kind: "commit", sha: "7523ce0abc" }, null)).toBe(
      "Commit 7523ce0",
    );
    expect(reviewedChangeLabel(local, { kind: "uncommitted" }, null)).toBe("Uncommitted changes");
  });

  it("says why an empty branch diff is empty", () => {
    const local = { kind: "local" } as const;
    expect(reviewNoChangesText(local, { kind: "branch" }, "origin/dev")).toBe(
      "No commits in branch vs origin/dev here. If the work is not committed yet, review Uncommitted instead.",
    );
    expect(reviewNoChangesText(local, { kind: "uncommitted" }, null)).toBe(
      "No uncommitted changes here.",
    );
  });
});

describe("reviewStopPlan", () => {
  const environmentId = EnvironmentId.make("env");
  const shell = (id: string, parent: string | null, running: boolean) => ({
    id: ThreadId.make(id),
    environmentId,
    parentThreadId: parent === null ? null : ThreadId.make(parent),
    archivedAt: null,
    session: null,
    latestTurn: running
      ? {
          turnId: TurnId.make(`${id}-turn`),
          state: "running" as const,
          requestedAt: "2026-10-01T10:00:00.000Z",
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        }
      : null,
  });

  it("stops the review's working agents, then discards for all of them, never the chat", () => {
    const plan = reviewStopPlan(
      [
        shell("chat", null, true),
        shell("review", "chat", false),
        shell("lens-a", "review", true),
        shell("lens-b", "review", false),
        shell("sibling", "chat", true),
      ],
      { environmentId, threadId: ThreadId.make("review") },
    );
    expect(plan.stop).toEqual(["review", "lens-a"]);
    // The reviewer last, so an answer a lens still held for it is dropped before it is unpaused.
    expect(plan.discard).toEqual(["lens-a", "lens-b", "review"]);
  });
});

describe("reviewStatusText", () => {
  const label = "Deep review · GPT-6.1";
  it("says how long a review has run, and what became of one that stopped", () => {
    const text = (progress: Parameters<typeof reviewStatusText>[0]["progress"], newer = false) =>
      reviewStatusText({ progress, label, elapsedMs: 6 * 60_000 + 30_000, newer });
    expect(text({ kind: "running", partial: false })).toBe(
      "Reviewing… Deep review · GPT-6.1 · 6 min",
    );
    expect(text({ kind: "running", partial: false }, true)).toBe(
      "A new review is running: Deep review · GPT-6.1 · 6 min",
    );
    expect(text({ kind: "failed", error: "Quota exceeded\n  at frame", partial: false })).toBe(
      "Review failed: Quota exceeded",
    );
    expect(text({ kind: "ended", partial: false })).toBe(
      "The review ended without sending findings",
    );
    expect(text({ kind: "ended", partial: true })).toBe(
      "The review ended before sending all its findings",
    );
    expect(text({ kind: "done" })).toBeNull();
  });

  it("says how long a review that is over took", () => {
    expect(formatReviewDuration(19_400)).toBe("took 19s");
    expect(formatReviewDuration(200)).toBe("took 1s");
    expect(formatReviewDuration(3 * 60_000 + 20_000)).toBe("took 3 min");
    expect(formatReviewDuration(65 * 60_000)).toBe("took 1 h 5 min");
    expect(
      reviewStatusText({
        progress: { kind: "ended", partial: false },
        label: "Deep review · GPT-6.1",
        elapsedMs: 0,
        durationMs: 19_000,
        newer: false,
      }),
    ).toBe("The review ended without sending findings · took 19s");
  });

  it("counts whole minutes, then hours, and cuts an error to one line", () => {
    expect(formatReviewElapsed(30_000)).toBe("just started");
    expect(formatReviewElapsed(65 * 60_000)).toBe("1 h 5 min");
    expect(formatReviewElapsed(120 * 60_000)).toBe("2 h");
    // A clock a little behind the server's never shows a negative time.
    expect(formatReviewElapsed(-5_000)).toBe("just started");
    expect(shortReviewError("x".repeat(200))).toHaveLength(140);
    expect(shortReviewError(null)).toBe("the reviewer stopped with an error");
  });

  it("names the step of sending findings by how many were sent", () => {
    const set = (count: number, complete?: boolean) => ({
      findings: Array.from({ length: count }, () => ({}) as never),
      needsChecking: [],
      ...(complete === undefined ? {} : { complete }),
    });
    expect(reviewFindingsSentText(null)).toBe("Sending findings");
    expect(reviewFindingsSentText(set(1, false))).toBe("Sent 1 finding so far");
    expect(reviewFindingsSentText(set(4))).toBe("Sent 4 findings");
  });
});

describe("what a review of a chat's work reads", () => {
  const pr = (number: number, title: string | null = null) => ({
    host: "github.com",
    repository: "acme/web",
    number,
    title,
  });
  const changes = (overrides: Partial<AgentReviewChanges> = {}): AgentReviewChanges => ({
    pullRequest: null,
    dirty: true,
    branch: { base: "origin/main" },
    canReviewLocal: true,
    canScope: true,
    ...overrides,
  });
  const labels = (input: AgentReviewChanges) =>
    agentReviewTargetChoices(input).map((target) => agentReviewTargetLabel(target));
  const inferred = (section: Parameters<typeof inferAgentReviewTarget>[0], input = changes()) => {
    const target = inferAgentReviewTarget(section, input);
    return target === null ? null : agentReviewTargetLabel(target);
  };

  it("offers only what has changes, and what the server can review", () => {
    expect(labels(changes({ pullRequest: pr(12) }))).toEqual([
      "This PR #12",
      "Current changes",
      "Branch vs origin/main",
    ]);
    expect(labels(changes({ dirty: false, branch: null }))).toEqual([]);
    expect(labels(changes({ branch: { base: null } }))).toEqual([
      "Current changes",
      "Branch vs its base",
    ]);
    expect(labels(changes({ pullRequest: pr(12), canReviewLocal: false }))).toEqual([
      "This PR #12",
    ]);
  });

  it("offers the project's other open pull requests after the chat's own work", () => {
    const open = [pr(12, "Own"), pr(9, "Fix the login race"), pr(8, null)];
    expect(labels(changes({ pullRequest: pr(12), openPullRequests: open, dirty: false }))).toEqual([
      "This PR #12",
      "Branch vs origin/main",
      "PR #9 · Fix the login race",
      "PR #8",
    ]);
    // A chat without its own pull request still reviews its changes unless one is picked.
    expect(inferred("branch-range", changes({ openPullRequests: open, dirty: false }))).toBe(
      "Branch vs origin/main",
    );
    expect(inferred(null, changes({ openPullRequests: open, dirty: false, branch: null }))).toBe(
      null,
    );
  });

  it("cuts a long title short and reviews a picked pull request as the chat's agent", () => {
    const long = pr(4, "A".repeat(80));
    const [target] = agentReviewTargetChoices(
      changes({ openPullRequests: [long], dirty: false, branch: null }),
    );
    expect(agentReviewTargetLabel(target!)).toBe(`PR #4 · ${"A".repeat(47)}…`);
    expect(agentReviewTargetRequest(target!, { projectId: PROJECT_ID, threadId: CHAT })).toEqual({
      kind: "pull-request",
      reference: { projectId: PROJECT_ID, host: "github.com", repository: "acme/web", number: 4 },
      sourceThreadId: CHAT,
    });
  });

  it("leaves what to read to a server that cannot be told, or to a checkout not read yet", () => {
    expect(labels(changes({ canScope: false }))).toEqual(["Local changes"]);
    expect(labels(changes({ dirty: null, branch: null }))).toEqual(["Local changes"]);
    expect(labels(changes({ canScope: false, dirty: false, branch: null }))).toEqual([]);
  });

  it("reads the uncommitted changes from those or a turn's diff while the tree is dirty", () => {
    const withPullRequest = changes({ pullRequest: pr(12) });
    expect(inferred("working-tree", withPullRequest)).toBe("Current changes");
    expect(inferred("turn", withPullRequest)).toBe("Current changes");
    expect(inferred("turn", changes({ dirty: false, pullRequest: pr(12) }))).toBe("This PR #12");
    expect(inferred("turn", changes({ dirty: false }))).toBe("Branch vs origin/main");
  });

  it("reads what is committed from the branch diff: the pull request, else the branch", () => {
    expect(inferred("branch-range", changes({ pullRequest: pr(12) }))).toBe("This PR #12");
    expect(inferred("branch-range")).toBe("Branch vs origin/main");
    // A diff with nothing in it falls to the other.
    expect(inferred("branch-range", changes({ branch: null }))).toBe("Current changes");
    expect(inferred("working-tree", changes({ dirty: false }))).toBe("Branch vs origin/main");
  });

  it("finds nothing to review in a clean checkout without a pull request", () => {
    expect(inferred("working-tree", changes({ dirty: false, branch: null }))).toBeNull();
    expect(inferred(null, changes({ dirty: false, branch: null, pullRequest: pr(3) }))).toBe(
      "This PR #3",
    );
  });

  it("tries a review again on what it read, as the same chat's agent", () => {
    const link = {
      host: "github.com",
      repository: "acme/web",
      number: 7,
      url: "https://github.com/acme/web/pull/7",
      source: "manual",
      linkedAt: "2026-08-01T00:00:00.000Z",
      snapshot: null,
      stack: null,
    } satisfies ThreadPullRequestLink;
    const reviewer = { projectId: PROJECT_ID, parentThreadId: CHAT, pullRequests: [link] };
    const pullRequest = {
      kind: "pull-request",
      reference: { projectId: PROJECT_ID, host: "github.com", repository: "acme/web", number: 7 },
      sourceThreadId: CHAT,
    };
    expect(agentReviewRetryRequest({ reviewer, scope: null, findingsTarget: null })).toEqual(
      pullRequest,
    );
    // A local review that was told what to read is one, whatever its branch is linked to.
    expect(
      agentReviewRetryRequest({ reviewer, scope: { kind: "uncommitted" }, findingsTarget: null }),
    ).toEqual({ kind: "local", projectId: PROJECT_ID, sourceThreadId: CHAT });
    expect(
      agentReviewRetryRequest({ reviewer, scope: null, findingsTarget: { kind: "local" } }),
    ).toEqual({ kind: "local", projectId: PROJECT_ID, sourceThreadId: CHAT });
    // A local review of the project's workspace belongs to no chat to name its checkout.
    expect(
      agentReviewRetryRequest({
        reviewer: { projectId: PROJECT_ID, parentThreadId: null, pullRequests: [] },
        scope: null,
        findingsTarget: null,
      }),
    ).toBeNull();
  });

  it("names a picked commit by its short SHA", () => {
    expect(
      agentReviewTargetLabel({ kind: "local", scope: { kind: "commit", sha: "a1b2c3d4e5" } }),
    ).toBe("Commit a1b2c3d");
  });
});
