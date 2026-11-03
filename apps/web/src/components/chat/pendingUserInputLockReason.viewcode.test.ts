// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { pendingUserInputLockReason } from "./pendingUserInputLockReason";

const open = { canRespond: true, disabled: false, isResponding: false };

// ViewCode guard: a question whose options are locked says why, instead of greying out silently.
describe("pending question lock reason (ViewCode)", () => {
  it("is empty while the question can be answered", () => {
    expect(pendingUserInputLockReason(open)).toBeNull();
  });

  it("names each lock, an ended question before the in-flight state the composer also reports", () => {
    expect(pendingUserInputLockReason({ ...open, isResponding: true })).toBe(
      "Sending your answer…",
    );
    expect(pendingUserInputLockReason({ ...open, disabled: true })).toBe(
      "You can't answer questions from this connection.",
    );
    expect(
      pendingUserInputLockReason({ canRespond: false, disabled: false, isResponding: true }),
    ).toBe("This question can no longer be answered.");
  });

  it("is shown on the question card", () => {
    const card = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "ComposerPendingUserInputPanel.tsx"),
      "utf8",
    );
    expect(card).toContain("pendingUserInputLockReason({ canRespond, disabled, isResponding })");
    expect(card).toContain("{lockReason}");
  });
});
