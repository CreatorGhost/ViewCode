// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const read = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, file), "utf8");

// Goal runs, side chats and the provider picker are ViewCode modules with their own tests.
// Users reach them only through call sites in upstream's ChatView, CommandPalette, ChatHeader
// and MessagesTimeline, which need the whole app to render. A merge that takes upstream's copy
// of one of those files drops the entry point with no conflict and no type error.
describe("ViewCode chat entry points", () => {
  // d80c168cb
  it("runs a thread goal from the chat, the header and the palette", () => {
    const chatView = read("ChatView.tsx");
    expect(chatView).toContain("threadGoalRunState({");
    expect(chatView).toContain("sendThreadGoalRunMessage(");
    expect(read("chat/ChatHeader.tsx")).toContain("<ThreadGoalChip");
    expect(read("CommandPalette.tsx")).toContain("threadGoalRunState");
  });

  // 1afad9c67
  it("names a thread started by Run goal after its goal", () => {
    expect(read("ChatView.tsx")).toContain("threadGoalRunTitle({");
  });

  // 73417ff6e, 38ab96c3a
  it("opens side chats from the chat, the palette and a message", () => {
    expect(read("ChatView.tsx")).toContain("<SidechatHost");
    const palette = read("CommandPalette.tsx");
    expect(palette).toContain("openSideChat");
    expect(palette).toContain('title: "Ask in side chat"');
    const timeline = read("chat/MessagesTimeline.tsx");
    expect(timeline).toContain("useAskInSideChat(");
    expect(timeline).toContain("<ForkFromMessageButton");
  });

  // 439e17288
  it("brings the provider picker back when no AI tool is on", () => {
    expect(read("ChatView.tsx")).toContain("<NoProviderPrompt");
  });
});
