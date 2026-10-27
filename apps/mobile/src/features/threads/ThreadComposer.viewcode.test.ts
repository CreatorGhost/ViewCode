// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// ViewCode's composer toolbar puts the access chip, the model chip and the Goal chip in one row
// beside the mic and send buttons. React Native children default to flexShrink 0, so without
// these wrappers the model chip kept its width on a phone and pushed the Goal chip over the mic
// and the stop button. Only the model chip may shrink, and the group clips.
describe("phone composer toolbar (ViewCode)", () => {
  it("lets only the model chip give way, and clips the group", () => {
    const composer = read("ThreadComposer.tsx");
    expect(composer).toContain(
      '<View className="min-w-0 shrink flex-row items-center overflow-hidden">',
    );
    expect(composer).toMatch(
      /<View className="min-w-0 shrink">\s*<ComposerInlineControl\s+accessibilityLabel="Model and reasoning settings"/,
    );
    expect(composer).toMatch(
      /<View className="shrink-0">\s*<ComposerInlineControl\s+accessibilityLabel=\{`Goal: /,
    );
  });
});
