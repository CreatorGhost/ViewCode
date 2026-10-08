import { describe, expect, it } from "vite-plus/test";

import {
  availablePullRequestMergeMethods,
  canMergePullRequest,
  summarizePullRequestChecks,
  summarizePullRequestMerge,
} from "./pullRequestScreen.logic";

const check = (status: Parameters<typeof summarizePullRequestChecks>[0][number]["status"]) => ({
  name: `check-${status}`,
  status,
  description: null,
  url: null,
});

const mergeable = {
  state: "open" as const,
  isDraft: false,
  capabilities: {
    diff: true,
    comment: true,
    actions: ["merge" as const],
    mergeMethods: ["merge" as const, "squash" as const],
  },
  viewerPermissions: {
    actions: ["merge" as const],
    comment: true,
    resolve: true,
    verdicts: [],
    requestReviewers: true,
  },
  mergeCapabilities: { merge: true, squash: true, rebase: true },
};

describe("summarizePullRequestChecks", () => {
  it("counts skipped checks as passed and names what is still running", () => {
    expect(
      summarizePullRequestChecks([check("success"), check("skipped"), check("pending")]),
    ).toEqual({ label: "2 of 3 passed · 1 running", tone: "warning" });
  });

  it("reports failures ahead of running checks", () => {
    expect(summarizePullRequestChecks([check("failure"), check("pending")]).tone).toBe("negative");
    expect(summarizePullRequestChecks([]).label).toBe("No checks");
  });
});

describe("summarizePullRequestMerge", () => {
  it("separates conflicts from a branch that is only behind", () => {
    expect(summarizePullRequestMerge({ state: "open", mergeability: "conflicting" }).tone).toBe(
      "negative",
    );
    expect(
      summarizePullRequestMerge({
        state: "open",
        mergeability: "mergeable",
        baseComparison: "behind",
        behindBy: 2,
      }).label,
    ).toBe("No conflicts · 2 commits behind");
  });
});

describe("merge offer", () => {
  it("offers squash first, and only methods both the host and repository allow", () => {
    expect(availablePullRequestMergeMethods(mergeable)).toEqual(["squash", "merge"]);
    expect(
      availablePullRequestMergeMethods({
        ...mergeable,
        mergeCapabilities: { merge: true, squash: false, rebase: true },
      }),
    ).toEqual(["merge"]);
  });

  it("hides merging on drafts and for viewers without permission", () => {
    expect(canMergePullRequest(mergeable)).toBe(true);
    expect(canMergePullRequest({ ...mergeable, isDraft: true })).toBe(false);
    expect(
      canMergePullRequest({
        ...mergeable,
        viewerPermissions: { ...mergeable.viewerPermissions, actions: [] },
      }),
    ).toBe(false);
  });
});
