import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { canStartLinkedPullRequestWatch } from "./linkedPullRequestWatch";

const activeThread = {
  archivedAt: null,
  settledAt: null,
  settledOverride: null,
  parentThreadId: null,
};

describe("mobile linked pull request watch eligibility", () => {
  it("requires an operable server capability and an existing active thread", () => {
    expect(canStartLinkedPullRequestWatch(activeThread, true)).toBe(true);
    expect(canStartLinkedPullRequestWatch(activeThread, false)).toBe(false);
    expect(canStartLinkedPullRequestWatch(null, true)).toBe(false);
    for (const state of [
      { archivedAt: "2026-10-18T00:00:00Z" },
      { settledAt: "2026-10-18T00:00:00Z" },
      { settledOverride: "settled" as const },
    ]) {
      expect(canStartLinkedPullRequestWatch({ ...activeThread, ...state }, true)).toBe(false);
    }
  });

  it("uses native lineage to distinguish a fork from a delegated child", () => {
    const child = { ...activeThread, parentThreadId: ThreadId.make("parent") };
    expect(
      canStartLinkedPullRequestWatch(
        {
          ...child,
          source: { lineage: { relationshipToParent: "subagent" } },
        },
        true,
      ),
    ).toBe(false);
    expect(
      canStartLinkedPullRequestWatch(
        {
          ...child,
          source: { lineage: { relationshipToParent: "fork" } },
        },
        true,
      ),
    ).toBe(true);
  });

  it("fails closed for an unclassified compatibility child but preserves side chats", () => {
    const child = { ...activeThread, parentThreadId: ThreadId.make("parent") };
    expect(canStartLinkedPullRequestWatch(child, true)).toBe(false);
    expect(canStartLinkedPullRequestWatch({ ...child, kind: "sidechat" }, true)).toBe(true);
  });
});
