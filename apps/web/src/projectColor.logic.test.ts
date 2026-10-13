import { describe, expect, it } from "vite-plus/test";

import { projectColorsUsedElsewhere, resolveProjectGroupColor } from "./projectColor.logic";

describe("resolveProjectGroupColor", () => {
  it("uses the folder's own colour, else a checkout's, else the default", () => {
    expect(resolveProjectGroupColor({ projectColor: "blue", memberProjects: [] })).toBe("blue");
    expect(
      resolveProjectGroupColor({
        projectColor: null,
        memberProjects: [{ projectColor: null }, { projectColor: "rose" }],
      }),
    ).toBe("rose");
    expect(resolveProjectGroupColor({ memberProjects: [{}, { projectColor: null }] })).toBeNull();
  });
});

describe("projectColorsUsedElsewhere", () => {
  it("collects the colours of every other folder", () => {
    const groups = [
      { projectKey: "a", projectColor: "blue" as const, memberProjects: [] },
      { projectKey: "b", projectColor: "rose" as const, memberProjects: [] },
      { projectKey: "c", projectColor: null, memberProjects: [{ projectColor: "lime" as const }] },
      { projectKey: "d", memberProjects: [] },
    ];
    expect([...projectColorsUsedElsewhere(groups, "a")].sort()).toEqual(["lime", "rose"]);
    expect([...projectColorsUsedElsewhere(groups, "d")].sort()).toEqual(["blue", "lime", "rose"]);
  });
});
