import type { OrchestrationV2Subagent } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type { SubagentTurnItem } from "../../lib/threadActivity";
import { presentSpawnedAgents } from "./spawnedAgentsPresentation";

const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 20, 10, 0, seconds));
const NOW = Date.UTC(2026, 9, 20, 10, 0, 50);

function item(
  n: number,
  status: SubagentTurnItem["status"],
  fields: Partial<SubagentTurnItem> = {},
): SubagentTurnItem {
  return {
    id: `item-${n}`,
    subagentId: `node-${n}`,
    title: `Subagent: Agent ${n}`,
    driver: "codex",
    childThreadId: `child-${n}`,
    status,
    result: null,
    startedAt: at(0),
    completedAt: status === "running" ? null : at(20),
    ...fields,
  } as unknown as SubagentTurnItem;
}

describe("presentSpawnedAgents", () => {
  it("reads each agent's state from its lead's live record before its turn item", () => {
    const live = {
      id: "node-1",
      status: "completed",
      result: "## Report\n\n**Done:** fixed `auth.ts`",
      startedAt: at(0),
      completedAt: at(30),
    } as unknown as OrchestrationV2Subagent;
    const presentation = presentSpawnedAgents(
      [
        { item: item(1, "running"), live, control: undefined },
        { item: item(2, "running", { progress: "Reading files" }), live: null, control: undefined },
        { item: item(3, "failed"), live: null, control: undefined },
        {
          item: item(4, "running"),
          live: null,
          control: { paused: true, queued: 2 },
        },
      ],
      NOW,
    );
    expect(presentation).toMatchObject({
      heading: "Spawned 4 agents",
      summary: "1 working · 1 paused · 1 done · 1 failed",
      working: true,
      active: true,
      elapsed: "50s",
    });
    expect(
      presentation.rows.map((row) => [
        row.title,
        row.state,
        row.tone,
        row.statusLabel,
        row.elapsed,
      ]),
    ).toEqual([
      ["Agent 1", "done", "done", "done", "30s"],
      ["Agent 2", "working", "working", null, "50s"],
      ["Agent 3", "failed", "failed", "failed", "20s"],
      // A paused agent has no end yet and is not running, so it shows no clock.
      ["Agent 4", "paused", "attention", "paused · 2 queued", null],
    ]);
    // A report reads as plain text, a working agent shows its current step.
    expect(presentation.rows[0]!.detail).toBe("Report Done: fixed auth.ts");
    expect(presentation.rows[1]!.detail).toBe("Reading files");
  });

  it("stops the clock once every agent has finished", () => {
    const presentation = presentSpawnedAgents(
      [
        { item: item(1, "completed"), live: null, control: undefined },
        { item: item(2, "cancelled", { completedAt: at(40) }), live: null, control: undefined },
      ],
      NOW,
    );
    expect(presentation).toMatchObject({
      summary: "1 done · 1 stopped",
      working: false,
      active: false,
      elapsed: "40s",
    });
    expect(presentation.rows.map((row) => row.tone)).toEqual(["done", "quiet"]);
  });
});
