import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// ViewCode's look is three stylesheets upstream never has. They only reach the app
// through these imports, and an upstream rewrite of index.css or main.tsx drops them
// without a conflict: the app then renders upstream's theme with no error anywhere.
describe("ViewCode stylesheets", () => {
  it("are imported by the app entry and the base stylesheet", () => {
    expect(read("main.tsx")).toContain('import "./viewcode-theme.css";');
    const index = read("index.css");
    expect(index).toContain('@import "./viewcode-chat.css";');
    expect(index).toContain('@import "./viewcode-native.css";');
  });

  it("exist beside them", () => {
    for (const file of ["viewcode-theme.css", "viewcode-chat.css", "viewcode-native.css"]) {
      expect(NodeFS.existsSync(NodePath.join(import.meta.dirname, file)), file).toBe(true);
    }
  });
});
