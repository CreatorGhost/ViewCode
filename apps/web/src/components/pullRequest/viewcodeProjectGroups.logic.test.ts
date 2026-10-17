import { EnvironmentId, ProjectId, SourceControlProviderKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  partitionPullRequestsWithPriority,
  type EnvironmentPullRequestEntry,
} from "./pullRequestList.logic";
import {
  viewCodePullRequestProjectGroups,
  viewCodeUnreadableProjectReasons,
} from "./viewcodeProjectGroups.logic";

function row(number: number, project = "work", environment = "local"): EnvironmentPullRequestEntry {
  return {
    environmentId: EnvironmentId.make(environment),
    provider: SourceControlProviderKind.make("github"),
    host: "github.com",
    projectId: ProjectId.make(project),
    projectTitle: project,
    repository: `owner/${project}`,
    number,
    title: `Change ${number}`,
    url: `https://github.com/owner/${project}/pull/${number}`,
    author: { login: "author", name: null, avatarUrl: null },
    headBranch: "feature",
    baseBranch: "main",
    state: "open",
    isDraft: false,
    mergeability: "mergeable",
    additions: 1,
    deletions: 0,
    createdAt: "2026-10-01T00:00:00Z",
    updatedAt: `2026-10-${String(number).padStart(2, "0")}T00:00:00Z`,
    viewerReviewRequested: false,
    labels: [],
    viewerLogin: project === "work" ? "work-account" : "personal-account",
  };
}

const labels = new Map([
  ["local:work", "Work folder"],
  ["local:personal", "Personal folder"],
]);

describe("ViewCode project groups over native priority reads", () => {
  it("retains authored/review-requested rows outside the feed while grouping by sidebar folder", () => {
    const priority = partitionPullRequestsWithPriority([row(3)], [row(1)], [row(2, "personal")]);
    const groups = viewCodePullRequestProjectGroups(priority, labels, "");
    expect(
      groups.map((group) => [group.label, group.entries.map((entry) => entry.number)]),
    ).toEqual([
      ["Work folder", [3, 1]],
      ["Personal folder", [2]],
    ]);
    expect(groups.flatMap((group) => group.entries.map((entry) => entry.viewerLogin))).toEqual([
      "work-account",
      "work-account",
      "personal-account",
    ]);
  });

  it("preserves a ranked search and scopes equal project ids to their environment", () => {
    const groups = viewCodePullRequestProjectGroups(
      [
        { key: "authored", label: "Authored", entries: [row(1), row(3)] },
        { key: "others", label: "Others", entries: [row(2, "work", "remote")] },
      ],
      labels,
      "search",
    );
    expect(groups.map((group) => [group.key, group.entries.map((entry) => entry.number)])).toEqual([
      ["local:work", [1, 3]],
      ["remote:work", [2]],
    ]);
    expect(groups[1]?.label).toBe("owner/work");
  });
});

it("keeps each unreadable project reason when two environments use the same project name", () => {
  const reasons = viewCodeUnreadableProjectReasons(
    [
      { environmentId: "local", projectTitle: "Work", message: "Work account denied" },
      { environmentId: "remote", projectTitle: "Work", message: "Remote credential missing" },
      { environmentId: "local", projectTitle: "Work", message: "Second local repository denied" },
    ],
    new Map([
      ["local", "Desktop"],
      ["remote", "Server"],
    ]),
  );
  expect([...reasons]).toEqual([
    ["Work (Desktop)", "Work account denied"],
    ["Work (Server)", "Remote credential missing"],
    ["Work (Desktop) · 2", "Second local repository denied"],
  ]);
});
