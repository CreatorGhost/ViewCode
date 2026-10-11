import { ProjectId, ThreadId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { reviewFixCandidates } from "./reviewFix.logic";

const PROJECT_ID = ProjectId.make("project-1");
const PR_TARGET = {
  kind: "pull-request",
  host: "github.com",
  repository: "t3tools/t3code",
  number: 7,
  url: "https://github.com/t3tools/t3code/pull/7",
} as const;

const link = (number: number, source: ThreadPullRequestLink["source"] = "manual") =>
  ({
    host: "github.com",
    repository: "T3Tools/T3Code",
    number,
    url: `https://github.com/T3Tools/T3Code/pull/${number}`,
    source,
    linkedAt: "2026-08-01T00:00:00.000Z",
    snapshot: null,
    stack: null,
  }) satisfies ThreadPullRequestLink;

const thread = (
  id: string,
  overrides: Partial<Parameters<typeof reviewFixCandidates>[0]["threads"][number]> = {},
) => ({
  id: ThreadId.make(id),
  projectId: PROJECT_ID,
  branch: null,
  worktreePath: null,
  pullRequests: [],
  archivedAt: null,
  updatedAt: "2026-08-01T00:00:00.000Z",
  ...overrides,
});

const review = thread("review", { pullRequests: [link(7)] });

describe("reviewFixCandidates", () => {
  it("offers the threads linked to the reviewed pull request, newest first, never the review", () => {
    const result = reviewFixCandidates({
      reviewThread: review,
      target: PR_TARGET,
      threads: [
        review,
        thread("older", { pullRequests: [link(7)], updatedAt: "2026-08-02T00:00:00.000Z" }),
        thread("other-pr", { pullRequests: [link(8)] }),
        thread("newer", { pullRequests: [link(7)], updatedAt: "2026-08-05T00:00:00.000Z" }),
        thread("archived", { pullRequests: [link(7)], archivedAt: "2026-08-06T00:00:00.000Z" }),
        thread("dismissed", { pullRequests: [link(7, "stack-dismissed")] }),
      ],
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["newer", "older"]);
    expect(result.preselectedId).toBeNull();
  });

  it("preselects the only session working on the pull request", () => {
    const result = reviewFixCandidates({
      reviewThread: review,
      target: PR_TARGET,
      threads: [review, thread("author", { pullRequests: [link(7)] })],
    });
    expect(result.preselectedId).toBe("author");
  });

  it("offers the threads on a local review's own checkout", () => {
    const localReview = thread("review", { branch: "feature", worktreePath: "/w/feature" });
    const result = reviewFixCandidates({
      reviewThread: localReview,
      target: { kind: "local" },
      threads: [
        localReview,
        thread("same", { branch: "feature", worktreePath: "/w/feature" }),
        thread("main", { branch: "main", worktreePath: null }),
        thread("elsewhere", {
          projectId: ProjectId.make("project-2"),
          branch: "feature",
          worktreePath: "/w/feature",
        }),
      ],
    });
    expect(result.candidates.map((candidate) => candidate.id)).toEqual(["same"]);
    expect(result.preselectedId).toBe("same");
  });

  it("has nothing to preselect when no session works on the change", () => {
    expect(
      reviewFixCandidates({ reviewThread: review, target: PR_TARGET, threads: [review] }),
    ).toEqual({ candidates: [], preselectedId: null });
  });
});
