// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// ViewCode's composer features are their own modules, reached only through call sites in
// upstream's ChatComposer.tsx and ComposerPrimaryActions.tsx. Rendering the composer needs
// the whole app, and a merge that takes upstream's copy of either file drops these call
// sites without a conflict or a type error, so this checks the wiring itself.
describe("ViewCode composer wiring", () => {
  // 66ad64dab
  it("explains a provider or project gate instead of reporting a disconnection", () => {
    const composer = read("ChatComposer.tsx");
    expect(composer).toContain("composerAvailabilityDisabledReason({");
    expect(composer).toContain("availabilityDisabledReason={availabilityDisabledReason}");
    expect(composer).not.toMatch(
      /isEnvironmentUnavailable=\{\s*environmentUnavailable !== null \|\|/,
    );
    expect(read("ComposerPrimaryActions.tsx")).toContain("availabilityDisabledReason !== null");
  });

  // 48cbb4797
  it("offers debug mode in the compact menu when the mode controls fold into it", () => {
    expect(read("ChatComposer.tsx")).toContain(
      "debugMode: { on: props.debugMode, onChange: props.onDebugModeChange }",
    );
    expect(read("CompactComposerControlsMenu.tsx")).toContain("Debug mode");
  });

  // 708f0f5f3
  it("opens the context and limits card from the ring beside send", () => {
    expect(read("ChatComposer.tsx")).toContain("<ComposerUsageLimitsPopover");
  });

  // c888518d9
  it("dictates into the composer", () => {
    const composer = read("ChatComposer.tsx");
    expect(composer).toContain("<ComposerDictationButton");
    expect(composer).toContain("<ComposerDictationControls");
  });

  // e34009140
  it("keeps ViewCode's extras menu in the composer", () => {
    expect(read("ChatComposer.tsx")).toContain("<ComposerExtrasMenu");
  });

  // a8d7dda46
  it("stops only this thread's agents from the stop button", () => {
    expect(read("ComposerPrimaryActions.tsx")).toContain("<AgentStopButton");
  });
});
