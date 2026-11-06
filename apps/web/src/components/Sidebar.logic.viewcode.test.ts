import { describe, expect, it } from "vite-plus/test";

import { isSidebarTopLevelFork } from "./Sidebar.logic";

// ViewCode guard: forks are listed beside their source, not nested under it.
describe("isSidebarTopLevelFork (ViewCode)", () => {
  it("lists a fork at the top level", () => {
    expect(isSidebarTopLevelFork({ lineage: { relationshipToParent: "fork" } })).toBe(true);
  });

  it("keeps a sidechat under its parent", () => {
    expect(
      isSidebarTopLevelFork({ lineage: { relationshipToParent: "fork" }, kind: "sidechat" }),
    ).toBe(false);
  });

  it("keeps subagents and plain threads as they were", () => {
    expect(isSidebarTopLevelFork({ lineage: { relationshipToParent: "subagent" } })).toBe(false);
    expect(isSidebarTopLevelFork({ lineage: { relationshipToParent: null } })).toBe(false);
  });
});
