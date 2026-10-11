import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  buildAgentReviewStart,
  canChooseLocalReviewScope,
  filterReviewCommits,
  formatReviewElapsed,
  localReviewScopeLabel,
  pastedReviewCommitSha,
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
      "Branch against origin/main",
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

  it("counts whole minutes, then hours, and cuts an error to one line", () => {
    expect(formatReviewElapsed(30_000)).toBe("just started");
    expect(formatReviewElapsed(65 * 60_000)).toBe("1 h 5 min");
    expect(formatReviewElapsed(120 * 60_000)).toBe("2 h");
    // A clock a little behind the server's never shows a negative time.
    expect(formatReviewElapsed(-5_000)).toBe("just started");
    expect(shortReviewError("x".repeat(200))).toHaveLength(140);
    expect(shortReviewError(null)).toBe("the reviewer stopped with an error");
  });
});
