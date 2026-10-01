import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildHomeFolderList,
  countHomeStatusFilters,
  resolveHomeAgentModelLabel,
  resolveHomeAgentStatus,
  type HomeFolderListItem,
} from "./homeFolderList";
import { buildHomeProjectScopes } from "./homeThreadList";

const ENV = EnvironmentId.make("env");
const NOW = "2026-06-10T00:00:00.000Z";

function project(id: string, title: string): EnvironmentProject {
  return {
    environmentId: ENV,
    id: ProjectId.make(id),
    title,
    workspaceRoot: `/workspaces/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
  };
}

function thread(
  id: string,
  projectId: string,
  input: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    environmentId: ENV,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    title: id,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    pullRequests: [],
    latestTurn: null,
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    archivedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...input,
    settledOverride: input.settledOverride ?? null,
    settledAt: input.settledAt ?? null,
  };
}

const child = (id: string, parent: string, input: Partial<EnvironmentThreadShell> = {}) =>
  thread(id, "app", { parentThreadId: ThreadId.make(parent), ...input });

const settled = { settledOverride: "settled", settledAt: "2026-06-05T00:00:00.000Z" } as const;

const scopes = buildHomeProjectScopes({
  projects: [project("app", "App"), project("docs", "Docs")],
  environmentId: null,
  projectGroupingMode: "separate",
});

function build(
  threads: EnvironmentThreadShell[],
  options: {
    readonly searchQuery?: string;
    readonly collapsedFolderKeys?: string[];
    readonly expandedLeadKeys?: string[];
    readonly expandedSettledFolderKeys?: string[];
    readonly onlyScope?: (typeof scopes)[number];
    readonly statusFilter?: "all" | "working" | "needs-you";
  } = {},
) {
  return buildHomeFolderList({
    threads,
    scopes: options.onlyScope ? [options.onlyScope] : scopes,
    projectScoped: options.onlyScope !== undefined,
    pendingTasks: [],
    environmentId: null,
    searchQuery: options.searchQuery ?? "",
    ...(options.statusFilter ? { statusFilter: options.statusFilter } : {}),
    now: NOW,
    collapsedFolderKeys: new Set(options.collapsedFolderKeys),
    expandedLeadKeys: new Set(options.expandedLeadKeys?.map((id) => `${ENV}:${id}`)),
    expandedSettledFolderKeys: new Set(options.expandedSettledFolderKeys),
    snoozedShelfExpanded: false,
  });
}

/** Compact picture of the list: one string per row. */
function describeRows(items: readonly HomeFolderListItem[]): string[] {
  return items.map((item) => {
    switch (item.type) {
      case "folder-header":
        return `folder ${item.title} (${item.count})${item.expanded ? "" : " closed"}`;
      case "folder-lead":
        return `lead ${item.entry.item.thread.id}${item.entry.item.variant === "slim" ? " slim" : ""}`;
      case "folder-agents":
        return `agents ${item.agentCount}${item.expanded ? " open" : ""}${item.muted ? " muted" : ""}`;
      case "folder-child":
        return `${"  ".repeat(item.depth)}child ${item.thread.id} ${item.status}`;
      case "folder-settled":
        return `settled ${item.count}${item.expanded ? " open" : ""}`;
      case "v2-pending":
        return `pending ${item.pendingTask.key}`;
      case "v2-snoozed-shelf":
        return `snoozed ${item.count}`;
    }
  });
}

describe("buildHomeFolderList", () => {
  it("groups leads into project folders with their agents behind a disclosure", () => {
    const threads = [
      thread("lead", "app"),
      child("worker", "lead", { session: sessionWith("running") }),
      child("helper", "worker"),
      thread("notes", "docs"),
    ];
    expect(describeRows(build(threads).items)).toEqual([
      "folder App (1)",
      "lead lead",
      "agents 2",
      "folder Docs (1)",
      "lead notes",
    ]);
    expect(describeRows(build(threads, { expandedLeadKeys: ["lead"] }).items)).toEqual([
      "folder App (1)",
      "lead lead",
      "agents 2 open",
      "  child worker working",
      "    child helper stopped",
      "folder Docs (1)",
      "lead notes",
    ]);
  });

  it("collapses a folder to its header and hides empty folders", () => {
    expect(
      describeRows(build([thread("lead", "app")], { collapsedFolderKeys: [scopes[0]!.key] }).items),
    ).toEqual(["folder App (1) closed"]);
  });

  it("keeps a settled lead's tree together in a collapsed Settled row", () => {
    const threads = [
      thread("open", "app"),
      thread("done", "app", settled),
      child("still-running", "done", { session: sessionWith("running") }),
    ];
    expect(describeRows(build(threads).items)).toEqual([
      "folder App (1)",
      "lead open",
      "settled 1",
    ]);
    expect(
      describeRows(build(threads, { expandedSettledFolderKeys: [scopes[0]!.key] }).items),
    ).toEqual([
      "folder App (1)",
      "lead open",
      "settled 1 open",
      "lead done slim",
      "agents 1 muted",
    ]);
  });

  it("lists pinned leads above the folders", () => {
    const threads = [thread("pinned", "app", { pinnedAt: NOW }), thread("other", "app")];
    expect(describeRows(build(threads).items)).toEqual([
      "lead pinned",
      "folder App (1)",
      "lead other",
    ]);
  });

  it("lists a thread of an unknown project loose instead of dropping it", () => {
    const threads = [thread("stray", "gone"), thread("other", "app")];
    expect(describeRows(build(threads).items)).toEqual([
      "lead stray",
      "folder App (1)",
      "lead other",
    ]);
    expect(describeRows(build(threads, { onlyScope: scopes[1]! }).items)).toEqual([]);
  });

  it("searches active, settled and agent titles, opening what hides a match", () => {
    const threads = [
      thread("lead", "app", settled),
      child("fix-login", "lead"),
      thread("unrelated", "app"),
      thread("notes", "docs"),
    ];
    expect(
      describeRows(
        build(threads, {
          searchQuery: "LOGIN",
          collapsedFolderKeys: [scopes[0]!.key],
        }).items,
      ),
    ).toEqual([
      "folder App (0)",
      "settled 1 open",
      "lead lead slim",
      "agents 1 open muted",
      "  child fix-login stopped",
    ]);
  });
});

function sessionWith(status: "running" | "ready" | "stopped" | "error") {
  return {
    threadId: ThreadId.make("session"),
    status,
    providerName: "codex",
    runtimeMode: "full-access" as const,
    activeTurnId: null,
    lastError: null,
    updatedAt: NOW,
  };
}

describe("resolveHomeAgentStatus", () => {
  it("reads what the agent is doing", () => {
    const base = thread("t", "app");
    expect(resolveHomeAgentStatus({ ...base, session: sessionWith("running") })).toBe("working");
    expect(resolveHomeAgentStatus({ ...base, session: sessionWith("ready") })).toBe("idle");
    expect(resolveHomeAgentStatus({ ...base, session: sessionWith("stopped") })).toBe("stopped");
    expect(resolveHomeAgentStatus(base)).toBe("stopped");
    expect(resolveHomeAgentStatus({ ...base, session: sessionWith("error") })).toBe("failed");
    expect(
      resolveHomeAgentStatus({
        ...base,
        session: sessionWith("running"),
        hasPendingApprovals: true,
      }),
    ).toBe("needs-you");
  });
});

describe("resolveHomeAgentModelLabel", () => {
  it("names the model the way its provider lists it, else compacts the id", () => {
    const configs = new Map([
      [
        ENV,
        {
          providers: [
            {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              models: [{ slug: "claude-opus-5", name: "Claude Opus 5", shortName: "Opus 5" }],
            },
          ],
        },
      ],
    ]) as unknown as Parameters<typeof resolveHomeAgentModelLabel>[0];
    const listed = thread("t", "app", {
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-5",
      },
    });
    const unlisted = thread("u", "app", {
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-sonnet-4-20250514",
      },
    });
    expect(resolveHomeAgentModelLabel(configs, listed)).toBe("Opus 5");
    expect(resolveHomeAgentModelLabel(configs, unlisted)).toBe("sonnet-4");
  });
});

describe("agent control on the folder list", () => {
  const threads = [
    thread("lead", "app", { session: sessionWith("running") }),
    child("worker", "lead", { session: sessionWith("running") }),
    child("paused", "lead"),
  ];
  const list = buildHomeFolderList({
    threads,
    scopes,
    projectScoped: false,
    pendingTasks: [],
    environmentId: null,
    searchQuery: "",
    now: NOW,
    collapsedFolderKeys: new Set(),
    expandedLeadKeys: new Set([`${ENV}:lead`]),
    expandedSettledFolderKeys: new Set(),
    snoozedShelfExpanded: false,
    agentControl: new Map([[`${ENV}:paused`, { paused: true, queued: 2 }]]),
  });

  it("marks a stopped agent paused and counts it on the agents row", () => {
    expect(describeRows(list.items)).toEqual([
      "folder App (1)",
      "lead lead",
      "agents 2 open",
      "  child worker working",
      "  child paused paused",
    ]);
    const agentsRow = list.items.find((item) => item.type === "folder-agents");
    expect(agentsRow?.type === "folder-agents" && agentsRow.pausedCount).toBe(1);
    const pausedRow = list.items.find(
      (item) => item.type === "folder-child" && item.thread.id === "paused",
    );
    expect(pausedRow?.type === "folder-child" && pausedRow.queued).toBe(2);
  });

  it("gives the lead its tree's counts for Stop all", () => {
    const lead = list.items.find((item) => item.type === "folder-lead");
    expect(lead?.type === "folder-lead" && lead.agentTree).toEqual({
      running: 2,
      paused: 1,
      queued: 2,
    });
  });
});

describe("home status filter", () => {
  const running = { session: { status: "running" } } as Partial<EnvironmentThreadShell>;
  const threads = [
    thread("busy", "app", running),
    thread("blocked", "app", { hasPendingApprovals: true }),
    thread("broken", "docs", { session: { status: "error" } } as Partial<EnvironmentThreadShell>),
    thread("quiet", "docs"),
    thread("lead", "app"),
    child("worker", "lead", running),
  ];
  const leads = (filter: "all" | "working" | "needs-you") =>
    build(threads, { statusFilter: filter }).items.flatMap((item) =>
      item.type === "folder-lead" ? [item.entry.item.thread.id] : [],
    );

  it("keeps every thread for all", () => {
    expect(leads("all").sort()).toEqual(["blocked", "broken", "busy", "lead", "quiet"]);
  });

  it("keeps working threads and a lead whose child agent is working", () => {
    expect(leads("working").sort()).toEqual(["busy", "lead"]);
    expect(describeRows(build(threads, { statusFilter: "working" }).items)).toContain(
      "  child worker working",
    );
  });

  it("counts lead trees per chip", () => {
    expect(countHomeStatusFilters(threads)).toEqual({ all: 5, working: 2, "needs-you": 2 });
  });

  it("keeps approvals and failures for needs you", () => {
    expect(leads("needs-you").sort()).toEqual(["blocked", "broken"]);
  });
});
