import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidechatCreateInput,
  FRESH_SIDECHAT,
  isSidechat,
  resolveActiveSidechat,
  SIDECHAT_TITLE,
  sidechatLabel,
  sidechatsOf,
  sidechatTitleFromQuestion,
} from "./sidechat.ts";

const parent = ThreadId.make("main");

const shell = (
  id: string,
  overrides: Partial<{
    kind: "sidechat" | null;
    parentThreadId: ThreadId | null;
    archivedAt: string | null;
    updatedAt: string;
  }> = {},
) => ({
  id: ThreadId.make(id),
  kind: "sidechat" as "sidechat" | null,
  parentThreadId: parent as ThreadId | null,
  archivedAt: null as string | null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...overrides,
});

describe("sidechatsOf", () => {
  it("keeps only the parent's live side chats, newest first", () => {
    const threads = [
      shell("old", { updatedAt: "2026-01-01T00:00:00.000Z" }),
      shell("new", { updatedAt: "2026-01-02T00:00:00.000Z" }),
      shell("archived", { archivedAt: "2026-01-02T00:00:00.000Z" }),
      shell("elsewhere", { parentThreadId: ThreadId.make("other") }),
      shell("agent", { kind: null }),
    ];
    expect(sidechatsOf(threads, parent).map((thread) => thread.id)).toEqual(["new", "old"]);
    expect(threads.map((thread) => thread.id)).toEqual([
      "old",
      "new",
      "archived",
      "elsewhere",
      "agent",
    ]);
  });
});

describe("resolveActiveSidechat", () => {
  const chats = [shell("a"), shell("b")];

  it("prefers the remembered side chat while it exists", () => {
    expect(resolveActiveSidechat(chats, ThreadId.make("b"))?.id).toBe("b");
  });

  it("falls back to the first when the remembered one is gone", () => {
    expect(resolveActiveSidechat(chats, ThreadId.make("gone"))?.id).toBe("a");
    expect(resolveActiveSidechat([], null)).toBeNull();
  });

  it("shows an empty dock after New side chat even when side chats exist", () => {
    expect(resolveActiveSidechat(chats, FRESH_SIDECHAT)).toBeNull();
  });
});

describe("sidechatLabel", () => {
  it("uses the first line of the question and clips long ones", () => {
    expect(sidechatLabel("  Why did you pick sqlite?\nsecond line")).toBe(
      "Why did you pick sqlite?",
    );
    expect(sidechatLabel("x".repeat(80))).toHaveLength(48);
    expect(sidechatLabel(null)).toBe(SIDECHAT_TITLE);
  });
});

describe("isSidechat", () => {
  it("is true only for the side chat kind", () => {
    expect(isSidechat({ kind: "sidechat" })).toBe(true);
    expect(isSidechat({ kind: null })).toBe(false);
    expect(isSidechat({})).toBe(false);
  });
});

describe("sidechatTitleFromQuestion", () => {
  it("uses a default for whitespace and the same single-line label as the web dock", () => {
    expect(sidechatTitleFromQuestion(" \n ")).toBe(SIDECHAT_TITLE);
    expect(sidechatTitleFromQuestion("  Explain this change\nwith details  ")).toBe(
      "Explain this change",
    );
    expect(sidechatTitleFromQuestion("x".repeat(80))).toBe(`${"x".repeat(47)}…`);
  });
});

describe("buildSidechatCreateInput", () => {
  const parentThread = Object.freeze({
    id: parent,
    projectId: ProjectId.make("project"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    branch: "feature/example",
    worktreePath: "/tmp/example",
  });

  it("inherits the parent's provider and workspace without changing the parent", () => {
    const input = buildSidechatCreateInput({
      parent: parentThread,
      threadId: ThreadId.make("question"),
      question: "Why this design?\nAnother detail",
    });
    expect(input).toEqual({
      threadId: "question",
      projectId: "project",
      title: "Why this design?",
      modelSelection: parentThread.modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "feature/example",
      worktreePath: "/tmp/example",
      parentThreadId: "main",
      kind: "sidechat",
    });
    expect(parentThread.id).toBe(parent);
  });

  it("preserves a local workspace and the web dock's explicit model choice", () => {
    const modelSelection = { instanceId: ProviderInstanceId.make("claude"), model: "sonnet" };
    const input = buildSidechatCreateInput({
      parent: { ...parentThread, branch: null, worktreePath: null },
      threadId: ThreadId.make("local-question"),
      question: "",
      modelSelection,
    });
    expect(input.modelSelection).toBe(modelSelection);
    expect(input.branch).toBeNull();
    expect(input.worktreePath).toBeNull();
    expect(input.title).toBe(SIDECHAT_TITLE);
  });
});
