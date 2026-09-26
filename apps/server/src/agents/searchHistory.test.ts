import type { OrchestrationThread } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { searchThreadHistory } from "./searchHistory.ts";

const thread = {
  messages: [
    {
      role: "user",
      text: "Review the cordon rollback fix.",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    { role: "assistant", text: "Which PR?", createdAt: "2026-01-01T00:01:00.000Z" },
  ],
  activities: [
    {
      kind: "tool.completed",
      summary: "Ran command",
      createdAt: "2026-01-01T00:00:30.000Z",
      payload: { detail: 'gh pr view 1541 --json title\n{"title":"Fix cordon rollback"}' },
    },
  ],
} as unknown as Pick<OrchestrationThread, "messages" | "activities">;

describe("searchThreadHistory", () => {
  it("finds details that only exist in tool output", () => {
    const [match] = searchThreadHistory(thread, "gh pr 1541", 5);
    expect(match?.source).toBe("tool.completed");
    expect(match?.snippet).toContain("gh pr view 1541");
  });

  it("requires every query word and returns nothing for an empty query", () => {
    expect(searchThreadHistory(thread, "cordon nonexistent", 5)).toEqual([]);
    expect(searchThreadHistory(thread, "   ", 5)).toEqual([]);
    expect(searchThreadHistory(thread, "cordon", 5)).toHaveLength(2);
  });
});
