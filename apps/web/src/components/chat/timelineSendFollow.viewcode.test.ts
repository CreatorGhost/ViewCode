// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { timelineHasUserMessage } from "./timelineSendFollow";

const chatView = () =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", "ChatView.tsx"), "utf8");

// ViewCode guard: the timeline anchors only a thread's first message, and a follow-up relies on
// end-following, which re-pins only within a viewport of the end. A reader left above the end by
// the previous anchored reply stayed there after sending, and Scroll to end stayed hidden because
// neither the send nor a wheel down counted as leaving the end.
describe("timeline follows a follow-up send (ViewCode)", () => {
  it("tells a follow-up from a thread's first message", () => {
    const user = { kind: "message", message: { role: "user" } };
    const assistant = { kind: "message", message: { role: "assistant" } };
    expect(timelineHasUserMessage([])).toBe(false);
    expect(timelineHasUserMessage([assistant, { kind: "work" }])).toBe(false);
    expect(timelineHasUserMessage([user, assistant])).toBe(true);
  });

  it("moves to the end on a follow-up send, on both send paths", () => {
    expect(
      chatView().match(/timelineHasUserMessage\(timelineEntries\)\) \{\n\s+scrollToEnd\(\);/g),
    ).toHaveLength(2);
  });

  it("counts a wheel down a reply above the end as the reader's scroll", () => {
    expect(chatView()).toContain("} else if (event.deltaY > 0 && viewportIsAwayFromEnd()) {");
  });
});
