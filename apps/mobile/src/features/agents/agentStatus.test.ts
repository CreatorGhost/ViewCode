import { describe, expect, it } from "vite-plus/test";

import { agentStatusRank, sortAgentsByStatus } from "./agentStatus";
import type { HomeAgentStatus } from "../home/homeFolderList";

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
