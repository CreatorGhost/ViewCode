import { describe, expect, it } from "vite-plus/test";

import { activeAgentsSummaryText, agentStatusRank, sortAgentsByStatus } from "./agentStatus";
import type { HomeAgentStatus } from "../home/homeFolderList";

describe("activeAgentsSummaryText", () => {
  it("says how many agents sit idle when nothing runs, is held or waits", () => {
    expect(activeAgentsSummaryText({ running: 0, paused: 0, queued: 0 }, 5)).toBe("5 idle");
  });

  it("lists only the states that have agents, working first", () => {
    expect(activeAgentsSummaryText({ running: 2, paused: 1, queued: 0 }, 4)).toBe(
      "2 working · 1 paused",
    );
    expect(activeAgentsSummaryText({ running: 0, paused: 1, queued: 3 }, 2)).toBe(
      "1 paused · 3 queued",
    );
  });
});

describe("sortAgentsByStatus", () => {
  it("puts working agents first and keeps the original order within a status", () => {
    const agents: ReadonlyArray<{ name: string; status: HomeAgentStatus }> = [
      { name: "a", status: "stopped" },
      { name: "b", status: "idle" },
      { name: "c", status: "working" },
      { name: "d", status: "idle" },
      { name: "e", status: "needs-you" },
    ];
    expect(
      sortAgentsByStatus(agents, (agent) => agentStatusRank(agent.status)).map((a) => a.name),
    ).toEqual(["c", "e", "b", "d", "a"]);
  });
});
