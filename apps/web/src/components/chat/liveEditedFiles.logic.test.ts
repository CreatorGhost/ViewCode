import { describe, expect, it } from "vite-plus/test";

import { deriveLiveEditedFiles, toWorkspaceRelativePath } from "./liveEditedFiles.logic";

describe("deriveLiveEditedFiles", () => {
  const entries = [
    { turnId: "t1", changedFiles: ["a.ts", "b.ts"] },
    { turnId: "t2", changedFiles: ["old.ts"] },
    { turnId: "t1", changedFiles: ["b.ts", "c.ts"] },
    { turnId: "t1" },
  ] as never;

  it("lists each file of the running turn once, in first-edit order", () => {
    expect(deriveLiveEditedFiles(entries, "t1")).toEqual(["a.ts", "b.ts", "c.ts"]);
  });

  it("is empty when no turn is running", () => {
    expect(deriveLiveEditedFiles(entries, null)).toEqual([]);
  });
});

describe("toWorkspaceRelativePath", () => {
  it("names files the way the diff does, relative to the workspace root", () => {
    expect(toWorkspaceRelativePath("/repo/src/app.ts", "/repo")).toBe("src/app.ts");
    expect(toWorkspaceRelativePath("/repo/src/app.ts", "/repo/")).toBe("src/app.ts");
    expect(toWorkspaceRelativePath("C:\\repo\\src\\app.ts", "C:\\repo")).toBe("src/app.ts");
    expect(toWorkspaceRelativePath("./src/app.ts", "/repo")).toBe("src/app.ts");
    expect(toWorkspaceRelativePath("/elsewhere/x.ts", "/repo")).toBe("/elsewhere/x.ts");
  });
});
