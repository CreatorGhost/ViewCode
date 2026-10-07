import { describe, expect, it } from "vite-plus/test";

import { filterDiffFilePaths, stepChangeIndex } from "./diffNav.logic";

describe("stepChangeIndex", () => {
  it("starts at the ends and wraps", () => {
    expect(stepChangeIndex(null, 3, 1)).toBe(0);
    expect(stepChangeIndex(null, 3, -1)).toBe(2);
    expect(stepChangeIndex(2, 3, 1)).toBe(0);
    expect(stepChangeIndex(0, 3, -1)).toBe(2);
    expect(stepChangeIndex(0, 0, 1)).toBe(-1);
  });
});

describe("filterDiffFilePaths", () => {
  const paths = ["src/a/foo.ts", "src/foo/bar.ts", "README.md"];
  it("matches all terms and ranks basename hits first", () => {
    expect(filterDiffFilePaths(paths, "foo")).toEqual(["src/a/foo.ts", "src/foo/bar.ts"]);
    expect(filterDiffFilePaths(paths, "src bar")).toEqual(["src/foo/bar.ts"]);
    expect(filterDiffFilePaths(paths, "")).toEqual(paths);
  });
});
