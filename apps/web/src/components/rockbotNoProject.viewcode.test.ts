// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// RockBot keeps its chats in the scratch ("No project") folder only so its agent never runs inside
// a repository. That folder must not show through on a RockBot chat, and RockBot activity must
// not reorder it.
describe("RockBot chats never show as No project (ViewCode)", () => {
  it("drops the scratch folder's tab glyph and project tools in a RockBot chat", () => {
    const chatView = read("ChatView.tsx");
    expect(chatView).toContain("activeProject={isRockBotChat ? null : (activeProject ?? null)}");
    expect(chatView).toContain(
      "projectCwd={isRockBotChat ? null : (activeProject?.workspaceRoot ?? null)}",
    );
    expect(chatView).toContain(
      "terminalAvailable={activeProject !== null && !isRockBotChat && canOperateTerminal}",
    );
    expect(read("chat/ChatHeader.tsx")).toMatch(/isRockBot\s*\?\s*\{ glyph: <BotIcon/);
  });

  it("names RockBot in sidebar rows, the palette and Archived settings", () => {
    expect(read("Sidebar.tsx")).toMatch(/thread\.kind === "orchestrator"\s*\?\s*"RockBot"/);
    expect(read("CommandPalette.tsx")).toMatch(/thread\.kind === "orchestrator"\s*\?\s*null/);
    expect(read("settings/SettingsPanels.tsx")).toMatch(
      /thread\.source\.kind === "orchestrator"[\s\S]{0,400}title: "RockBot"/,
    );
  });

  it("keeps RockBot activity from reordering the No project folder", () => {
    expect(read("sidebar/useSidebarProjectGroups.ts")).toContain(
      "threads.filter((thread) => !isRockBot(thread.source))",
    );
  });
});
