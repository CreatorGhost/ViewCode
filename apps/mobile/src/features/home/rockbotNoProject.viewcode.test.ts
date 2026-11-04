// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// RockBot keeps its chats in the scratch ("No project") folder only to stay out of every
// repository, so the phone neither reorders that folder for RockBot nor offers a terminal there.
describe("RockBot chats never show as No project on mobile (ViewCode)", () => {
  it("leaves RockBot chats out of folder order and the terminal menu", () => {
    expect(read("HomeRouteScreen.tsx")).toContain(
      "threads: threads.filter((thread) => !isRockBot(thread))",
    );
    expect(read("homeTerminalTargets.ts")).toContain(
      "if (thread.archivedAt !== null || isRockBot(thread)) continue;",
    );
  });
});
