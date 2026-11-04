import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { viewCodeThread } from "../viewcodeThread.ts";
import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";

import {
  buildSidechatCreateInput,
  FRESH_SIDECHAT,
  sidechatHasOlderMessages,
  sidechatMessages,
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

  it("opens the most recently updated side chat without a prior selection", () => {
    const threads = sidechatsOf(
      [
        shell("phone", { updatedAt: "2026-01-01T00:00:00.000Z" }),
        shell("laptop", { updatedAt: "2026-01-02T00:00:00.000Z" }),
      ],
      parent,
    );
    expect(resolveActiveSidechat(threads, null)?.id).toBe("laptop");
  });

  it("prefers the remembered side chat while it exists", () => {
    expect(resolveActiveSidechat(chats, ThreadId.make("b"))?.id).toBe("b");
  });

  it("keeps an explicit selection when another chat receives a live update", () => {
    const threads = sidechatsOf(
      [shell("selected"), shell("updated-elsewhere", { updatedAt: "2026-01-03T00:00:00.000Z" })],
      parent,
    );
    expect(resolveActiveSidechat(threads, ThreadId.make("selected"))?.id).toBe("selected");
    expect(resolveActiveSidechat(threads, FRESH_SIDECHAT)).toBeNull();
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

describe("side chat transcript", () => {
  const parentThreadId = ThreadId.make("parent");
  const sidechatId = v2Projection.thread.id;
  const baseItem = (id: string, threadId: ThreadId) =>
    ({
      id: TurnItemId.make(id),
      threadId,
      runId: RunId.make(`run:${threadId}`),
      nodeId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
    }) as const;
  const item = (input: {
    readonly id: string;
    readonly threadId: ThreadId;
    readonly type: "user_message" | "assistant_message" | "reasoning";
    readonly text: string;
  }): OrchestrationV2TurnItem => {
    const base = { ...baseItem(input.id, input.threadId), providerThreadId: null };
    switch (input.type) {
      case "user_message":
        return {
          ...base,
          type: "user_message",
          createdBy: "user",
          creationSource: "web",
          inputIntent: "turn_start",
          messageId: MessageId.make(`message:${input.id}`),
          text: input.text,
          attachments: [],
        };
      case "assistant_message":
        return {
          ...base,
          type: "assistant_message",
          messageId: MessageId.make(`message:${input.id}`),
          text: input.text,
          streaming: false,
        };
      case "reasoning":
        return { ...base, type: "reasoning", text: input.text, streaming: false };
    }
  };
  // A native fork lists the parent's history before its fork marker and its own turns.
  const inherited = [
    item({ id: "p-user", threadId: parentThreadId, type: "user_message", text: "Fix the bug" }),
    item({ id: "p-think", threadId: parentThreadId, type: "reasoning", text: "Looking" }),
    item({ id: "p-reply", threadId: parentThreadId, type: "assistant_message", text: "Fixed" }),
  ];
  const own = [
    item({ id: "s-user", threadId: sidechatId, type: "user_message", text: "Why that fix?" }),
    item({ id: "s-reply", threadId: sidechatId, type: "assistant_message", text: "Because" }),
  ];
  const marker: OrchestrationV2TurnItem = {
    ...baseItem(`turn-item:fork:${sidechatId}`, sidechatId),
    runId: null,
    type: "fork",
    source: { type: "run", threadId: parentThreadId, runId: RunId.make("run:parent") },
    targetThreadId: sidechatId,
  };
  const sidechat = (ownItems: ReadonlyArray<OrchestrationV2TurnItem>) => {
    const rows: Array<OrchestrationV2ProjectedTurnItem> = [
      ...inherited.map((entry) => ({ item: entry, visibility: "inherited" as const })),
      { item: marker, visibility: "synthetic" as const },
      ...ownItems.map((entry) => ({ item: entry, visibility: "local" as const })),
    ].map((row, position) => ({
      ...row,
      position,
      sourceThreadId: row.item.threadId,
      sourceItemId: row.item.id,
    }));
    return viewCodeThread({
      ...v2Projection,
      thread: { ...v2Projection.thread, kind: "sidechat", parentThreadId },
      messages: ownItems.flatMap((entry) =>
        entry.type === "user_message" || entry.type === "assistant_message"
          ? [
              {
                id: entry.messageId,
                threadId: sidechatId,
                runId: entry.runId,
                nodeId: null,
                role: entry.type === "user_message" ? ("user" as const) : ("assistant" as const),
                text: entry.text,
                attachments: [],
                streaming: false,
                createdAt: v2Now,
                updatedAt: v2Now,
                createdBy: "user" as const,
                creationSource: "web" as const,
              },
            ]
          : [],
      ),
      turnItems: [...ownItems],
      visibleTurnItems: rows,
    });
  };

  it("shows only the side chat's own exchange, not the parent history it inherits", () => {
    const thread = sidechat(own);
    expect(thread.messages.map((message) => message.text)).toContain("Fix the bug");
    expect(sidechatMessages(thread.messages).map((message) => message.text)).toEqual([
      "Why that fix?",
      "Because",
    ]);
  });

  it("is empty before the first question rather than showing the parent history", () => {
    expect(sidechatMessages(sidechat([]).messages)).toEqual([]);
  });

  it("offers older pages only until the inherited history is reached", () => {
    const withParentLoaded = sidechat(own).messages;
    const ownOnly = sidechatMessages(withParentLoaded);
    expect(sidechatHasOlderMessages(true, withParentLoaded)).toBe(false);
    expect(sidechatHasOlderMessages(true, ownOnly)).toBe(true);
    expect(sidechatHasOlderMessages(false, ownOnly)).toBe(false);
  });
});
