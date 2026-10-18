import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { TimelineEntriesInput, TimelineEntriesProjection } from "../session-logic";
import { makeStreamingTimelineFixture } from "../test-fixtures";
import { useIncrementalTimelineEntries } from "./useIncrementalTimelineEntries";

let root: Root;
let observed: TimelineEntriesProjection["entries"];
function Probe({ threadKey, input }: { threadKey: string | null; input: TimelineEntriesInput }) {
  const entries = useIncrementalTimelineEntries(threadKey, input);
  useLayoutEffect(() => {
    observed = entries;
  }, [entries]);
  return null;
}
function input(text: string): TimelineEntriesInput {
  return {
    visibleTurnItems: makeStreamingTimelineFixture(text).visibleTurnItems,
    optimisticMessages: [],
  };
}
async function show(threadKey: string | null, input: TimelineEntriesInput) {
  await act(() => root.render(<Probe threadKey={threadKey} input={input} />));
  return observed;
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  root = createRoot(document.createElement("div"));
});
afterEach(async () => {
  await act(() => root.unmount());
  vi.unstubAllGlobals();
});

describe("bounded thread timeline projections", () => {
  it("reuses completed message objects on return while applying canonical streaming changes", async () => {
    const a = input("First streaming text");
    const first = await show("a", a);
    await show("b", input("Other thread"));
    const returned = await show("a", { ...a, optimisticMessages: [] });
    expect(returned).toBe(first);
    const changed: TimelineEntriesInput = {
      ...a,
      visibleTurnItems: a.visibleTurnItems.map((row) =>
        row.item.type === "assistant_message" && row.item.streaming
          ? { ...row, item: { ...row.item, text: "Canonical continuation" } }
          : row,
      ),
    };
    const updated = await show("a", changed);
    expect(updated[0]).toBe(first[0]);
    expect(updated.at(-1)).not.toBe(first.at(-1));
    expect(updated.at(-1)).toMatchObject({ message: { text: "Canonical continuation" } });
  });

  it("reconciles rollback removals and evicts the least recently displayed fourth projection", async () => {
    const a = input("a");
    const first = await show("a", a);
    const b = input("b");
    const bEntries = await show("b", b);
    await show("c", input("c"));
    await show("d", input("d"));
    expect(await show("b", b)).toBe(bEntries);
    expect(await show("a", a)).not.toBe(first);
    const reduced = await show("a", { ...a, visibleTurnItems: a.visibleTurnItems.slice(0, 2) });
    expect(reduced).toHaveLength(2);
    expect(reduced.some((entry) => entry.kind === "message" && entry.message.text === "a")).toBe(
      false,
    );
  });
});
