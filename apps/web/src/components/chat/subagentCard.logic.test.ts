import { describe, expect, it } from "vite-plus/test";
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  deriveSubagentCard,
  subagentLastProgressAt,
  subagentQuietMessage,
} from "./subagentCard.logic";

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
  it("explains a completed task's missing result without inventing an answer", () => {
    const card = deriveSubagentCard(agent({ status: "completed", result: "  " }), now);
    expect(card.result).toBeNull();
    expect(card.resultNotice).toBe("No separate task result was reported.");
    expect(card.latestActivity).toBe(card.resultNotice);
    for (const status of [
      "pending",
      "running",
      "waiting",
      "idle",
      "failed",
      "cancelled",
      "interrupted",
    ] as const) {
      expect(deriveSubagentCard(agent({ status }), now).resultNotice).toBeNull();
    }
    expect(
      deriveSubagentCard(agent({ status: "completed", result: "Done" }), now).resultNotice,
    ).toBeNull();
    expect(
      deriveSubagentCard(agent({ status: "completed", error: "Failure" }), now).resultNotice,
    ).toBeNull();
  });
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

describe("subagent quiet notice", () => {
  const began = Date.parse(start);

  it("appears after five quiet minutes and clears when progress resumes", () => {
    const task = agent();
    const last = subagentLastProgressAt(task);
    expect(subagentQuietMessage(last, began + 299_999)).toBeNull();
    expect(subagentQuietMessage(last, began + 300_000)).toBe(
      "No progress update for 5m. The provider may still be working.",
    );
    expect(subagentQuietMessage(last, began + 1_800_000)).toContain("30m");
    const next = agent({
      recentActivity: [{ at: "2026-09-27T10:05:00.000Z", summary: "Reading files" }],
    });
    expect(subagentQuietMessage(subagentLastProgressAt(next), began + 300_000)).toBeNull();
    expect(task.status).toBe("running");
  });

  it("does not mistake usage or metadata updates for progress", () => {
    const task = agent({ updatedAt: "2026-09-27T10:10:00.000Z", usage: { totalTokens: 50 } });
    expect(subagentLastProgressAt(task)).toBe(began);
    expect(subagentQuietMessage(subagentLastProgressAt(task), began + 600_000)).toContain("10m");
  });

  it.each(["waiting", "idle", "completed", "failed", "cancelled", "interrupted"] as const)(
    "does not warn about intentionally waiting or settled %s tasks",
    (status) => {
      expect(
        subagentQuietMessage(subagentLastProgressAt(agent({ status })), began + 600_000),
      ).toBeNull();
    },
  );

  it("starts a new quiet window on reactivation and ignores empty or invalid observations", () => {
    const task = agent({
      startedAt: "2026-09-27T10:09:00.000Z",
      recentActivity: [
        { at: start, summary: "Earlier run" },
        { at: "2026-09-27T10:10:00.000Z", summary: " " },
        { at: "invalid", summary: "Unknown time" },
      ],
    });
    expect(subagentLastProgressAt(task)).toBe(began + 540_000);
    expect(subagentQuietMessage(subagentLastProgressAt(task), began + 600_000)).toBeNull();
    expect(
      subagentQuietMessage(
        subagentLastProgressAt(agent({ startedAt: "invalid", firstSeenAt: "invalid" })),
        now,
      ),
    ).toBeNull();
    expect(subagentQuietMessage(began + 60_000, began)).toBeNull();
  });
});
