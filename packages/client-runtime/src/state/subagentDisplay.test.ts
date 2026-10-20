import { ProjectId, ProviderDriverKind } from "@t3tools/contracts";
import type { OrchestrationV2TurnItemStatus } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  subagentGroupSummary,
  resolveSubagentMetadata,
  subagentDetailPreview,
  spawnedAgentsHeading,
  spawnedAgentsMarker,
  subagentRowIsActive,
  subagentRowState,
  subagentRowStateLabel,
  summarizeSubagentRowStates,
  visibleAgentRows,
} from "./subagentDisplay.js";

describe("subagentGroupSummary", () => {
  it.each(["pending", "running", "waiting"] as const)(
    "keeps a mixed group live while a member is %s",
    (status) => {
      expect(subagentGroupSummary([{ status: "completed" }, { status }])).toEqual({
        label: "Kicked off 2 subagents",
        active: true,
        failed: false,
      });
    },
  );

  it("settles the label without disguising a failed member as success", () => {
    const statuses: OrchestrationV2TurnItemStatus[] = [
      "completed",
      "failed",
      "cancelled",
      "interrupted",
    ];
    expect(subagentGroupSummary(statuses.map((status) => ({ status })))).toEqual({
      label: "Ran 4 subagents",
      active: false,
      failed: true,
    });
  });

  it("uses a singular label for one idle member", () => {
    expect(subagentGroupSummary([{ status: "idle" }])).toEqual({
      label: "Ran 1 subagent",
      active: false,
      failed: false,
    });
  });
});

describe("resolveSubagentMetadata", () => {
  it("resolves provider aliases to catalog names, including custom models", () => {
    expect(
      resolveSubagentMetadata({
        model: "claude-haiku-4-5-20251001",
        provider: {
          driver: ProviderDriverKind.make("claudeAgent"),
          models: [
            {
              slug: "claude-haiku-4-5",
              name: "Claude Haiku 4.5",
              shortName: "Haiku 4.5",
              aliases: ["claude-haiku-4-5-20251001"],
              isCustom: false,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("Haiku 4.5");
    expect(
      resolveSubagentMetadata({
        model: "my-model",
        provider: {
          driver: ProviderDriverKind.make("acpRegistry"),
          models: [
            {
              slug: "my-model",
              name: "Cloud+ / My custom model",
              subProvider: "Cloud+",
              isCustom: true,
              capabilities: null,
            },
          ],
        },
      }).modelLabel,
    ).toBe("My custom model");
  });

  it("keeps unknown model identities and does not invent an unreported model", () => {
    expect(resolveSubagentMetadata({ model: " custom/model " }).modelLabel).toBe("custom/model");
    expect(
      resolveSubagentMetadata({
        model: null,
        provider: { driver: ProviderDriverKind.make("codex"), models: [] },
      }).modelLabel,
    ).toBe("Not reported");
    expect(resolveSubagentMetadata({ model: " " }).modelLabel).toBe("Not reported");
  });

  const parentThread = { projectId: ProjectId.make("parent"), worktreePath: null };
  const parentProject = { workspaceRoot: "/repo" };

  it("shows another project and its branch when the child has a different workspace", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "fix/agents", worktreePath: "/worktrees/agents" },
        childProject: {
          id: ProjectId.make("child"),
          title: "Other project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([
      { label: "Project", value: "Other project" },
      { label: "Branch", value: "fix/agents" },
    ]);
  });

  it("labels a detached worktree or another project workspace without a branch", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: null, worktreePath: "/worktrees/agents" },
      }).workspace,
    ).toEqual([{ label: "Worktree", value: "agents" }]);
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childProject: {
          id: parentThread.projectId,
          title: "Same project",
          workspaceRoot: "/other",
        },
      }).workspace,
    ).toEqual([{ label: "Workspace", value: "other" }]);
  });

  it("hides redundant workspace metadata and tolerates unavailable child shells", () => {
    expect(
      resolveSubagentMetadata({
        model: null,
        parentThread,
        parentProject,
        childThread: { branch: "main", worktreePath: "/repo" },
        childProject: { id: parentThread.projectId, title: "Same project", workspaceRoot: "/repo" },
      }).workspace,
    ).toEqual([]);
    expect(resolveSubagentMetadata({ model: null, parentThread, parentProject }).workspace).toEqual(
      [],
    );
  });
});

describe("subagentDetailPreview", () => {
  it("prefers progress for live work and results for settled work", () => {
    const details = { progress: "Reading files", result: "Found two\n  problems" };
    expect(subagentDetailPreview({ ...details, status: "running" })).toBe("Reading files");
    expect(subagentDetailPreview({ ...details, status: "completed" })).toBe("Found two problems");
    expect(
      subagentDetailPreview({ status: "failed", progress: "Last progress", result: " " }),
    ).toBe("Last progress");
    expect(subagentDetailPreview({ status: "pending" })).toBeNull();
  });
});

describe("spawned agent rows", () => {
  it("reads each agent's state, with a pause from agent control winning", () => {
    expect(subagentRowState("running")).toBe("working");
    expect(subagentRowState("pending")).toBe("queued");
    expect(subagentRowState("completed")).toBe("done");
    expect(subagentRowState("interrupted")).toBe("stopped");
    expect(subagentRowState("running", { paused: true })).toBe("paused");
    expect(subagentRowStateLabel("paused", { queued: 2 })).toBe("paused · 2 queued");
    expect(subagentRowStateLabel("failed")).toBe("failed");
  });

  it("keeps working, waiting, queued and paused agents in the live colour", () => {
    expect(
      (
        ["working", "waiting", "queued", "paused", "done", "failed", "stopped", "idle"] as const
      ).filter(subagentRowIsActive),
    ).toEqual(["working", "waiting", "queued", "paused"]);
  });

  it("summarises a spawn and picks its marker", () => {
    const states = ["working", "done", "working", "failed", "working", "working"] as const;
    expect(summarizeSubagentRowStates(states)).toBe("4 working · 1 done · 1 failed");
    expect(spawnedAgentsHeading(6)).toBe("Spawned 6 agents");
    expect(spawnedAgentsHeading(1)).toBe("Spawned 1 agent");
    expect(spawnedAgentsMarker(states)).toBe("live");
    expect(spawnedAgentsMarker(["done", "failed"])).toBe("dead-end");
    expect(spawnedAgentsMarker(["done", "stopped"])).toBe("merged");
  });

  it("lists every agent up to eight, then folds the rest", () => {
    const six = Array.from({ length: 6 }, (_, index) => index);
    expect(visibleAgentRows(six)).toEqual({ visible: six, hidden: 0 });
    const eight = Array.from({ length: 8 }, (_, index) => index);
    expect(visibleAgentRows(eight).hidden).toBe(0);
    const twelve = Array.from({ length: 12 }, (_, index) => index);
    expect(visibleAgentRows(twelve)).toEqual({ visible: twelve.slice(0, 7), hidden: 5 });
  });
});
