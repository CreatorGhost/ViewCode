import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { agentTree } from "./AgentMessaging.ts";

const shell = (id: string, parentThreadId: string | null = null, kind?: "sidechat") =>
  ({ id, parentThreadId, title: id, kind }) as unknown as OrchestrationThreadShell;

describe("agentTree", () => {
  const threads = [
    shell("lead"),
    shell("frontend", "lead"),
    shell("backend", "lead"),
    shell("backend-db", "backend"),
    shell("unrelated"),
  ];

  it("returns the root and every descendant from any member of the tree", () => {
    const fromLeaf = agentTree(threads, "backend-db").map((thread) => thread.id);
    expect(fromLeaf).toEqual(["lead", "frontend", "backend", "backend-db"]);
    expect(agentTree(threads, "lead").map((thread) => thread.id)).toEqual(fromLeaf);
  });

  it("keeps unrelated threads out and tolerates a missing parent", () => {
    expect(agentTree(threads, "unrelated").map((thread) => thread.id)).toEqual(["unrelated"]);
    const orphan = [shell("child", "deleted-parent")];
    expect(agentTree(orphan, "child").map((thread) => thread.id)).toEqual(["child"]);
  });

  it("never counts a side chat as an agent, from either side", () => {
    const withSidechat = [...threads, shell("question", "lead", "sidechat")];
    expect(agentTree(withSidechat, "lead").map((thread) => thread.id)).toEqual([
      "lead",
      "frontend",
      "backend",
      "backend-db",
    ]);
    // The side chat does not climb to its parent's tree either.
    expect(agentTree(withSidechat, "question").map((thread) => thread.id)).toEqual(["question"]);
  });
});
