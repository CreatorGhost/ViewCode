import { describe, expect, it } from "vite-plus/test";

import { prFlowCreatingPhase, prFlowFromPullRequest, prFlowStatus } from "./prFlowModel";

const OPEN = {
  number: 128,
  title: "Retry the provider handoff on timeout",
  state: "open",
  headBranch: "fix/provider-handoff",
  baseBranch: "main",
  additions: 12,
  deletions: 3,
} as const;
const IDLE = { resolving: false, merging: false };

describe("prFlowCreatingPhase", () => {
  it("follows the git menu's steps while it opens a pull request", () => {
    expect(prFlowCreatingPhase(null)).toBe("committing");
    expect(prFlowCreatingPhase("Preparing feature ref...")).toBe("committing");
    expect(prFlowCreatingPhase("Generating commit message...")).toBe("committing");
    expect(prFlowCreatingPhase("Committing...")).toBe("committing");
    expect(prFlowCreatingPhase("Pushing to origin...")).toBe("pushing");
    expect(prFlowCreatingPhase("Preparing PR...")).toBe("opening");
    expect(prFlowCreatingPhase("Generating PR content...")).toBe("opening");
    expect(prFlowCreatingPhase("Creating pull request...")).toBe("opening");
    expect(prFlowCreatingPhase("Creating merge request...")).toBe("opening");
  });
});

describe("prFlowFromPullRequest", () => {
  it("is ready to merge when the host reports no conflicts and settled checks", () => {
    const flow = prFlowFromPullRequest(
      { ...OPEN, mergeability: "mergeable", checksState: "passing" },
      IDLE,
    );
    expect(flow?.phase).toBe("ready");
    expect(flow && prFlowStatus(flow).label).toBe("Ready to merge");
  });

  it("waits on running checks", () => {
    expect(prFlowFromPullRequest({ ...OPEN, checksState: "pending" }, IDLE)?.phase).toBe("testing");
  });

  it("reports failing checks instead of offering Merge", () => {
    const flow = prFlowFromPullRequest({ ...OPEN, checksState: "failing" }, IDLE);
    expect(flow?.phase).toBe("ready");
    expect(flow?.checksFailed).toBe(true);
    expect(flow && prFlowStatus(flow)).toMatchObject({ tone: "warning", label: "Checks failed" });
  });

  it("shows conflicts until they are gone, resolving once the agent was asked", () => {
    const conflicting = { ...OPEN, mergeability: "conflicting" } as const;
    const flow = prFlowFromPullRequest(conflicting, IDLE);
    expect(flow?.phase).toBe("conflicts");
    expect(flow && prFlowStatus(flow).label).toBe("Conflicts with main");
    expect(prFlowFromPullRequest(conflicting, { ...IDLE, resolving: true })?.phase).toBe(
      "resolving",
    );
    // Once the host no longer reports conflicts, asking no longer matters.
    expect(
      prFlowFromPullRequest({ ...OPEN, mergeability: "mergeable" }, { ...IDLE, resolving: true })
        ?.phase,
    ).toBe("ready");
  });

  it("merges, then stays merged", () => {
    expect(prFlowFromPullRequest(OPEN, { ...IDLE, merging: true })?.phase).toBe("merging");
    const merged = prFlowFromPullRequest({ ...OPEN, state: "merged" }, IDLE);
    expect(merged?.phase).toBe("merged");
    expect(merged && prFlowStatus(merged).label).toBe("Merged into main");
  });

  it("has nothing to show for a closed pull request", () => {
    expect(prFlowFromPullRequest({ ...OPEN, state: "closed" }, IDLE)).toBeNull();
  });
});
