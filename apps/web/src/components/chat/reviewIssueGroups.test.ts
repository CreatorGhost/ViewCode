import { describe, expect, it } from "vite-plus/test";

import { groupIssuesBySeverity, issueFileLabel } from "./reviewIssueGroups";

describe("groupIssuesBySeverity", () => {
  it("makes one group per run of a severity, in the order given", () => {
    const groups = groupIssuesBySeverity(
      [
        { n: 1, severity: "important" as const },
        { n: 2, severity: "important" as const },
        { n: 3, severity: "nit" as const },
        { n: 4, severity: "question" as const },
      ],
      (issue) => issue.severity,
    );
    expect(groups.map((group) => group.severity)).toEqual(["important", "nit", "question"]);
    expect(groups[0]?.items.map((issue) => issue.n)).toEqual([1, 2]);
    expect(groups[2]?.items.map((issue) => issue.n)).toEqual([4]);
  });

  it("has no groups for no issues", () => {
    expect(groupIssuesBySeverity([], () => "nit")).toEqual([]);
  });
});

describe("issueFileLabel", () => {
  it("names the file and its line, without the folders", () => {
    expect(issueFileLabel("agents/playbooks/callback.py", 131)).toBe("callback.py:131");
    expect(issueFileLabel("README.md", undefined)).toBe("README.md");
    expect(issueFileLabel("dir/", undefined)).toBe("dir/");
  });
});
