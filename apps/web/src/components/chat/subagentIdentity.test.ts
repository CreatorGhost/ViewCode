import { describe, expect, it } from "vite-plus/test";
import { subagentColors } from "./subagentIdentity";

describe("subagentColors", () => {
  it("gives eight agents distinct colors even when their IDs collide", () => {
    const ids = ["a", "i", "q", "y", "A", "I", "Q", "Y"];
    expect(new Set(subagentColors(ids).values()).size).toBe(ids.length);
  });

  it("keeps earlier agents' colors when new agents arrive or a roster is replayed", () => {
    const ids = ["hello_one", "hello_two"];
    const first = subagentColors(ids);
    expect(subagentColors(ids)).toEqual(first);
    const expanded = subagentColors([...ids, "audit"]);
    for (const id of ids) expect(expanded.get(id)).toBe(first.get(id));
  });

  it("handles repeated IDs and larger fleets without missing colors", () => {
    const ids = Array.from({ length: 30 }, (_, index) => `agent-${index}`);
    const colors = subagentColors([...ids, ids[0]!]);
    expect(colors.size).toBe(ids.length);
    for (const id of ids) expect(colors.get(id)).toBeTruthy();
  });
});
