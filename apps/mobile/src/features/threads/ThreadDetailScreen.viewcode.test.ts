// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// The pull request's chips above the phone composer (status or Create PR, and the diff size) are
// ViewCode's, mounted from upstream's thread screen. A merge taking upstream's copy would drop
// them with no type error, and the PR card's composer chips would vanish only on the phone.
describe("phone pull request chips (ViewCode)", () => {
  it("mounts the chips above the composer, over the Active agents bar", () => {
    const screen = read("ThreadDetailScreen.tsx");
    expect(screen).toContain("<ComposerPullRequestChips");
    expect(screen).toContain("topAccessory={composerKeyboardOpen ? null : composerTopAccessory}");
  });

  it("draws the PR card with the web card's graph, not a text summary", () => {
    expect(read("ThreadPullRequestFeedCard.tsx")).toContain("<PrFlowCard");
    expect(read("PrFlowCard.tsx")).toContain("layoutPrFlowGraph(flow)");
  });
});
