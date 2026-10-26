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

// Upstream keeps its panel toggles in a fixed cluster over the header's right
// edge and reserves 96px of header padding for it. ViewCode draws the toggles
// inside the header's actions while the panel is closed, so that reservation is
// an empty band at the right while the tabs truncate. A fixed control sits over
// the header only once the docked panel owns the title bar.
describe("chat header right reserve", () => {
  it("is written away while the right panel is closed", () => {
    const chatView = read("ChatView.tsx");
    expect(chatView).toContain("toolbarControlCount={inlineRightPanelOwnsTitleBar ? 1 : 0}");
    expect(chatView).toContain("{!inlineRightPanelOwnsTitleBar ? panelToggleControls : null}");
  });

  it("is sized by the count the header receives", () => {
    expect(read("chat/ChatHeader.tsx")).toContain(
      "paddingRight: `calc(${toolbarControlCount} * 2.75rem)`",
    );
  });
});

// Upstream compacts a stale Claude thread before the next send unless the chip is switched to
// Full. ViewCode reverses it (user decision): the chip offers compaction, and a send keeps the
// full history until it is pressed. An upstream merge brings the default back without conflict.
describe("compaction before a send is opt-in", () => {
  it("keeps the full history unless the chip was pressed for the thread", () => {
    const chatView = read("ChatView.tsx");
    expect(chatView).toContain(
      "const keepFullHistory = !compactBeforeSendThreadKeys.has(routeThreadKey);",
    );
    expect(chatView).toContain("setKeepFullHistory(routeThreadKey, true);");
  });

  it("offers compaction on the chip in both states", () => {
    const actions = read("chat/ComposerPrimaryActions.tsx");
    expect(actions).not.toContain('{keepFullHistory ? "Full" : "Compact"}');
    expect(actions).toContain("Click to compact first");
  });
});
