import { resolveAgentControlAvailability } from "@t3tools/client-runtime/state/child-agents";
import { describe, expect, it } from "vite-plus/test";

import {
  buildChildAgentMenuActions,
  buildLeadAgentMenuActions,
  isAgentMenuEvent,
} from "./agentMenus";

const ids = (actions: ReadonlyArray<{ readonly id?: string }>) => actions.map((a) => a.id);

describe("child agent menu", () => {
  it("offers Stop while running and Resume plus Discard once stopped", () => {
    expect(
      ids(
        buildChildAgentMenuActions(
          resolveAgentControlAvailability({ running: true, control: undefined }),
        ),
      ),
    ).toEqual(["agents:stop"]);
    expect(
      ids(
        buildChildAgentMenuActions(
          resolveAgentControlAvailability({
            running: false,
            control: { paused: true, queued: 1 },
          }),
        ),
      ),
    ).toEqual(["agents:resume", "agents:discard"]);
    expect(
      buildChildAgentMenuActions(
        resolveAgentControlAvailability({ running: false, control: undefined }),
      ),
    ).toEqual([]);
  });
});

describe("lead agent menu", () => {
  it("names how many agents Stop all stops", () => {
    const actions = buildLeadAgentMenuActions({ running: 3, paused: 0, queued: 0 });
    expect(actions.map((action) => action.title)).toEqual(["Stop all agents (3 running)"]);
  });

  it("offers the way back from a stop", () => {
    expect(ids(buildLeadAgentMenuActions({ running: 0, paused: 2, queued: 1 }))).toEqual([
      "agents:resume-all",
      "agents:discard-all",
    ]);
  });

  it("adds nothing to idle or agent-less leads and keeps arrays stable", () => {
    expect(buildLeadAgentMenuActions(null)).toEqual([]);
    expect(buildLeadAgentMenuActions({ running: 0, paused: 0, queued: 0 })).toEqual([]);
    expect(buildLeadAgentMenuActions({ running: 1, paused: 1, queued: 0 })).toBe(
      buildLeadAgentMenuActions({ running: 1, paused: 1, queued: 0 }),
    );
  });

  it("recognizes only its own events", () => {
    expect(isAgentMenuEvent("agents:stop-all")).toBe(true);
    expect(isAgentMenuEvent("delete")).toBe(false);
  });
});
