// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// The composer's "Create PR" chip runs upstream's git quick action through a presentation
// ViewCode added to GitActionsControl, so its default-branch prompt and toasts still apply. A
// merge that takes upstream's copy drops the presentation with no type error at the call site
// until it is built, and the chip quietly never shows.
describe("ViewCode git actions", () => {
  it("lets the composer's Create PR chip run the git menu's own pull request action", () => {
    const git = read("GitActionsControl.tsx");
    expect(git).toContain('presentation === "composer-chip"');
    expect(git).toContain("renderComposerChip?.({");
    expect(read("chat/prFlow/ThreadPrFlowCard.tsx")).toContain('presentation="composer-chip"');
  });
});
