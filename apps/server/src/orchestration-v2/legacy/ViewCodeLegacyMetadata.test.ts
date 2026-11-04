import { describe, expect, it } from "vite-plus/test";
import { viewCodeLegacyLineages, viewCodeLegacyMetadata } from "./ViewCodeLegacyMetadata.ts";

const row = (
  thread_id: string,
  parent_thread_id: string | null,
  kind: string | null = null,
  project_id = "project",
) => ({
  thread_id,
  project_id,
  parent_thread_id,
  kind,
});

describe("ViewCode legacy lineage", () => {
  it("maps nested agents and side chats independently of creation order", () => {
    const lineages = viewCodeLegacyLineages([
      row("side", "agent", "sidechat"),
      row("agent", "lead"),
      row("lead", null),
      row("grandchild", "agent"),
    ]);
    expect(lineages.get("lead")).toEqual({
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: "lead",
    });
    expect(lineages.get("agent")).toEqual({
      parentThreadId: "lead",
      relationshipToParent: "subagent",
      rootThreadId: "lead",
    });
    expect(lineages.get("side")).toEqual({
      parentThreadId: "agent",
      relationshipToParent: "fork",
      rootThreadId: "lead",
    });
    expect(lineages.get("grandchild")).toEqual({
      parentThreadId: "agent",
      relationshipToParent: "subagent",
      rootThreadId: "lead",
    });
  });

  it("does not create cyclic, missing, or cross-project native lineage", () => {
    const rows = [
      row("a", "b"),
      row("b", "a"),
      row("self", "self"),
      row("missing", "gone"),
      row("other", null, null, "other-project"),
      row("cross", "other"),
    ];
    const lineages = viewCodeLegacyLineages(rows);
    for (const value of rows) {
      expect(lineages.get(value.thread_id)).toEqual({
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: value.thread_id,
      });
    }
  });

  it("preserves a paused goal, debug mode, kind, and original parent", () => {
    const goal = {
      objective: "Finish the port",
      pausedAt: "2026-10-17T00:00:00.000Z",
      updatedAt: "2026-10-17T00:00:00.000Z",
    };
    expect(
      viewCodeLegacyMetadata({
        ...row("side", "missing", "sidechat"),
        goal_json: JSON.stringify(goal),
        debug_mode: 1,
      }),
    ).toEqual({ parentThreadId: "missing", kind: "sidechat", viewcodeGoal: goal, debugMode: true });
  });
});
