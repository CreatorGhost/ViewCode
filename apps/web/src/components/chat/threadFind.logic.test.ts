import { describe, expect, it } from "vite-plus/test";

import type { TimelineEntry } from "../../session-logic";
import { findThreadMatches, stepFindIndex } from "./threadFind.logic";

const message = (id: string, role: "user" | "assistant" | "system", text: string) =>
  ({
    id: `entry-${id}`,
    kind: "message",
    createdAt: "",
    message: { id, role, text },
  }) as unknown as TimelineEntry;

describe("findThreadMatches", () => {
  const entries = [
    message("a", "user", "Fix the Bug"),
    message("b", "assistant", "the bug is here, the BUG is there"),
    message("c", "system", "bug"),
  ];

  it("matches case-insensitively across user and assistant messages, in order", () => {
    expect(findThreadMatches(entries, "bug").map((m) => [m.messageId, m.occurrence])).toEqual([
      ["a", 0],
      ["b", 0],
      ["b", 1],
    ]);
  });

  it("finds nothing for a blank query", () => {
    expect(findThreadMatches(entries, "  ")).toEqual([]);
  });
});

describe("stepFindIndex", () => {
  it("wraps in both directions and handles no matches", () => {
    expect(stepFindIndex(3, 2, 1)).toBe(0);
    expect(stepFindIndex(3, 0, -1)).toBe(2);
    expect(stepFindIndex(3, -1, 1)).toBe(0);
    expect(stepFindIndex(0, -1, 1)).toBe(-1);
  });
});
