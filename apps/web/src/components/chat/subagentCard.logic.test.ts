import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import { deriveSubagentCard } from "./subagentCard.logic";

const start = "2026-09-27T10:00:00.000Z";
const updated = "2026-09-27T10:00:10.000Z";
const now = Date.parse("2026-09-27T10:00:30.000Z");

function agent(overrides: Partial<RuntimeSubagent> = {}): RuntimeSubagent {
  return {
    id: "audit",
    kind: "subagent",
    title: "Code audit",
    role: null,
    model: null,
    effort: null,
    status: "running",
    activationCount: 1,
    usage: null,
    progress: null,
    lastToolName: null,
    result: null,
    error: null,
    outputFile: null,
    parentAgentId: null,
    agentIndex: null,
    phaseIndex: null,
    phaseTitle: null,
    attempt: null,
    workflowName: null,
    phases: [],
    runHandles: null,
    recentActivity: [],
    firstSeenAt: start,
    startedAt: start,
    completedAt: null,
    updatedAt: updated,
    ...overrides,
  };
}

describe("deriveSubagentCard", () => {
  it.each([
    ["pending", "Starting", true],
    ["running", "Working", true],
    ["waiting", "Waiting", true],
    ["idle", "Idle", false],
    ["completed", "Completed", false],
    ["failed", "Failed", false],
    ["cancelled", "Stopped", false],
    ["interrupted", "Stopped", false],
  ] as const)(
    "labels %s without claiming a different lifecycle state",
    (status, statusLabel, isActive) => {
      expect(deriveSubagentCard(agent({ status }), now)).toMatchObject({ statusLabel, isActive });
    },
  );

  it("shows the latest observation instead of stale progress, with a bounded deduplicated history", () => {
    const summaries = [
      "one",
      "two",
      "three",
      "four",
      "five",
      "six",
      "six",
      "\n seven \n detail",
      "seven",
      " ",
    ];
    const card = deriveSubagentCard(
      agent({
        progress: "Older progress",
        recentActivity: summaries.map((summary) => ({ at: updated, summary })),
      }),
      now,
    );
    expect(card.latestActivity).toBe("seven");
    expect(card.history.map((entry) => entry.summary)).toEqual([
      "two",
      "three",
      "four",
      "five",
      "six",
      "seven",
    ]);
  });

  it("preserves revisited work while removing only consecutive duplicates", () => {
    expect(
      deriveSubagentCard(
        agent({
          recentActivity: ["Read file", "Run tests", "Read file"].map((summary) => ({
            at: updated,
            summary,
          })),
        }),
        now,
      ).history.map((entry) => entry.summary),
    ).toEqual(["Read file", "Run tests", "Read file"]);
  });

  it("falls back to progress or a tool name without inventing activity", () => {
    expect(
      deriveSubagentCard(agent({ progress: "\n Scanning files\nMore detail" }), now).latestActivity,
    ).toBe("Scanning files");
    expect(
      deriveSubagentCard(agent({ progress: " ", lastToolName: "Read file" }), now).latestActivity,
    ).toBe("Read file");
    expect(deriveSubagentCard(agent(), now).latestActivity).toBeNull();
    expect(deriveSubagentCard(agent({ progress: "Scanning files" }), now).history).toMatchObject([
      { at: updated, summary: "Scanning files" },
    ]);
    expect(deriveSubagentCard(agent({ lastToolName: "Read file" }), now).history).toMatchObject([
      { at: updated, summary: "Read file" },
    ]);
    expect(deriveSubagentCard(agent(), now).history).toEqual([]);
  });

  it("keeps distinct keys for same-time repeated activity and stable keys as older history drops", () => {
    const rows = ["Read file", "Run tests", "Read file", "Search", "Read file", "Finish"].map(
      (summary) => ({ at: updated, summary }),
    );
    const first = deriveSubagentCard(agent({ recentActivity: rows }), now).history;
    const next = deriveSubagentCard(
      agent({ recentActivity: [...rows.slice(1), { at: updated, summary: "Report" }] }),
      now,
    ).history;
    expect(new Set(first.map((entry) => entry.id)).size).toBe(first.length);
    expect(next.slice(0, -1).map((entry) => entry.id)).toEqual(
      first.slice(1).map((entry) => entry.id),
    );
  });

  it("keeps multiline result and error separate from progress and does not invent a model", () => {
    const card = deriveSubagentCard(
      agent({
        status: "failed",
        result: " Partial result\nwith details ",
        error: " Failed to finish\nwith explanation ",
        progress: "Read file",
        effort: "high",
      }),
      now,
    );
    expect(card).toMatchObject({
      latestActivity: "Failed to finish",
      result: "Partial result\nwith details",
      error: "Failed to finish\nwith explanation",
      modelLabel: null,
    });
    expect(
      deriveSubagentCard(agent({ model: "gpt-5.6-sol", effort: "high" }), now).modelLabel,
    ).toBe("gpt-5.6-sol · high");
    expect(
      deriveSubagentCard(
        agent({ status: "completed", result: "Done\nMore detail", progress: "Read file" }),
        now,
      ).latestActivity,
    ).toBe("Done");
  });

  it("ticks active work and freezes terminal and idle durations across later renders", () => {
    expect(deriveSubagentCard(agent(), now).elapsedMs).toBe(30_000);
    expect(deriveSubagentCard(agent(), now + 5_000).elapsedMs).toBe(35_000);
    for (const status of ["idle", "completed", "failed", "cancelled", "interrupted"] as const) {
      const settled = agent({ status });
      expect(deriveSubagentCard(settled, now).elapsedMs).toBe(10_000);
      expect(deriveSubagentCard(settled, now + 5_000).elapsedMs).toBe(10_000);
    }
    expect(
      deriveSubagentCard(
        agent({ status: "completed", completedAt: "2026-09-27T10:00:05.000Z" }),
        now,
      ).elapsedMs,
    ).toBe(5_000);
  });

  it("handles missing, invalid, and out-of-order timestamps without a false duration", () => {
    expect(deriveSubagentCard(agent({ startedAt: null, status: "pending" }), now).elapsedMs).toBe(
      30_000,
    );
    expect(
      deriveSubagentCard(agent({ startedAt: "invalid", firstSeenAt: "invalid" }), now).elapsedMs,
    ).toBeNull();
    expect(
      deriveSubagentCard(
        agent({ status: "completed", completedAt: "invalid", updatedAt: "invalid" }),
        now,
      ).elapsedMs,
    ).toBeNull();
    expect(
      deriveSubagentCard(agent({ startedAt: "2026-09-27T11:00:00.000Z" }), now).elapsedMs,
    ).toBe(0);
  });
});
