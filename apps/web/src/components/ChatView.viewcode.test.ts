// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// Upstream keeps its panel toggles in a fixed cluster over the header's right
// edge and reserves 96px of header padding for it. ViewCode draws the toggles
// inside the header's actions while the panel is closed, so that reservation is
// an empty band at the right while the tabs truncate. A fixed control sits over
// the header only once the docked panel owns the title bar.
describe("chat header right reserve", () => {
  it("is written away while the right panel is closed", () => {
    expect(read("ChatView.tsx")).toContain(
      "toolbarControlCount={inlineRightPanelOwnsTitleBar ? 1 : 0}",
    );
    expect(read("ChatView.tsx")).toContain(
      "{!inlineRightPanelOwnsTitleBar ? panelToggleControls : null}",
    );
  });

  it("is sized by the count the header receives", () => {
    const header = read(NodePath.join("chat", "ChatHeader.tsx"));
    expect(header).toContain("paddingRight: `calc(${toolbarControlCount} * 2.75rem)`");
  });
});
