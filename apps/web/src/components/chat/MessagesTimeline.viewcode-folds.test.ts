import { MessageId, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import type { TimelineEntry } from "../../session-logic";
import {
  deriveMessagesTimelineRows,
  deriveMessagesTimelineRowsWithState,
} from "./MessagesTimeline.logic";

const runId = RunId.make("finished-run");
const at = (second: number) => `2026-10-18T00:00:${String(second).padStart(2, "0")}Z`;
const message = (role: "user" | "assistant", second: number): TimelineEntry => ({
  kind: "message",
  id: role,
  createdAt: at(second),
  message: {
    id: MessageId.make(role),
    role,
    text: role === "user" ? "Inspect the change" : "Inspection complete",
    runId,
    ...(role === "user" ? { inputIntent: "turn_start" as const } : {}),
    createdAt: at(second),
    updatedAt: at(second),
    streaming: false,
  },
});
const input = {
  timelineEntries: [
    message("user", 0),
    {
      kind: "work",
      id: "read-file",
      createdAt: at(1),
      entry: { id: "read-file", runId, createdAt: at(1), label: "Read file", tone: "tool" },
    },
    message("assistant", 2),
  ] satisfies TimelineEntry[],
  isWorking: false,
  turnDiffSummaries: [],
  supportsConversationRollback: false,
};

describe("ViewCode finished-turn preference on v2 rows", () => {
  it("can show completed work and restore the native summary without losing the answer", () => {
    const folded = deriveMessagesTimelineRows(input);
    expect(folded.some((row) => row.kind === "turn-fold")).toBe(true);
    expect(folded.some((row) => row.kind === "work")).toBe(false);
    const expanded = deriveMessagesTimelineRows({ ...input, collapseFinishedTurns: false });
    expect(expanded.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(expanded.some((row) => row.kind === "work")).toBe(true);
    expect(expanded.filter((row) => row.kind === "message").map((row) => row.message.text)).toEqual(
      ["Inspect the change", "Inspection complete"],
    );
    expect(deriveMessagesTimelineRows({ ...input, collapseFinishedTurns: true })).toEqual(folded);
  });

  it("invalidates incremental folding when the saved preference changes in either direction", () => {
    const initial = deriveMessagesTimelineRowsWithState(input);
    const off = deriveMessagesTimelineRowsWithState(
      { ...input, collapseFinishedTurns: false },
      initial,
    );
    expect(off.rows).toEqual(
      deriveMessagesTimelineRows({ ...input, collapseFinishedTurns: false }),
    );
    const on = deriveMessagesTimelineRowsWithState(input, off);
    expect(on.rows).toEqual(initial.rows);
  });

  it("never folds the active response when the preference is enabled", () => {
    const active = deriveMessagesTimelineRows({ ...input, isWorking: true, runningRunId: runId });
    expect(active.some((row) => row.kind === "turn-fold")).toBe(false);
    expect(active.some((row) => row.kind === "work")).toBe(true);
  });
});
