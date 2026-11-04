// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

// The server re-checks a Cursor status that is not ready when a client's lease goes
// from offline to online (`provider/viewcode/cursorStatusRecheck.ts`). Only this
// report tells it, so an upstream rewrite that drops the field silently ends that.
describe("ViewCode client activity report", () => {
  it("says whether the browser is online, and reports again when that changes", () => {
    const source = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "backgroundActivityReporter.ts"),
      "utf8",
    );
    expect(source).toContain('networkType: navigator.onLine ? "online" : "offline"');
    expect(source).toContain('window.addEventListener("online", requestReport);');
    expect(source).toContain('window.addEventListener("offline", requestReport);');
  });
});
