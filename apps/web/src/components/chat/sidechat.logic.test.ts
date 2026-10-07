import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  FRESH_SIDECHAT,
  isPinnedToBottom,
  isSidechat,
  resolveActiveSidechat,
  SIDECHAT_TITLE,
  sidechatLabel,
  sidechatsOf,
} from "./sidechat.logic";

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

describe("isPinnedToBottom", () => {
  it("is true only within a few pixels of the bottom edge", () => {
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 600 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 590 })).toBe(true);
    expect(isPinnedToBottom({ scrollHeight: 1000, clientHeight: 400, scrollTop: 300 })).toBe(false);
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
