import type { EnvironmentThreadShell } from "@t3tools/client-runtime/viewcodeThread";

import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildHomeTerminalTargets, findSelectedTerminalTarget } from "./homeTerminalTargets";
import { buildHomeProjectScopes } from "./homeThreadList";

const ENV = EnvironmentId.make("env");

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

const scopes = buildHomeProjectScopes({
  projects: [project("app", "App"), project("docs", "Docs"), project("empty", "Empty")],
  environmentId: null,
  projectGroupingMode: "separate",
});

describe("buildHomeTerminalTargets", () => {
  it("picks each project's most recently active live thread, newest project first", () => {
    const targets = buildHomeTerminalTargets({
      scopes,
      threads: [
        thread("app-old", "app", { updatedAt: "2026-06-02T00:00:00.000Z" }),
        thread("app-new", "app", { updatedAt: "2026-06-04T00:00:00.000Z" }),
        thread("docs-only", "docs", { updatedAt: "2026-06-05T00:00:00.000Z" }),
      ],
    });

    expect(targets.map((target) => [target.projectTitle, target.threadId])).toEqual([
      ["Docs", "docs-only"],
      ["App", "app-new"],
    ]);
  });

  it("ignores archived threads and projects without a thread", () => {
    const targets = buildHomeTerminalTargets({
      scopes,
      threads: [
        thread("app-archived", "app", {
          updatedAt: "2026-06-09T00:00:00.000Z",
          archivedAt: "2026-06-09T00:00:00.000Z",
        }),
        thread("app-live", "app", { updatedAt: "2026-06-03T00:00:00.000Z" }),
      ],
    });

    expect(targets.map((target) => target.threadId)).toEqual(["app-live"]);
  });

  it("returns nothing when no project has a live thread", () => {
    expect(buildHomeTerminalTargets({ scopes, threads: [] })).toEqual([]);
  });
});

describe("findSelectedTerminalTarget", () => {
  const targets = buildHomeTerminalTargets({
    scopes,
    threads: [thread("app-1", "app"), thread("docs-1", "docs")],
  });

  it("matches the selected project by scope key or scoped project key", () => {
    const appScope = scopes.find((scope) => scope.title === "App");
    expect(findSelectedTerminalTarget(targets, appScope?.key ?? null)?.threadId).toBe("app-1");
    expect(findSelectedTerminalTarget(targets, `${ENV}:docs`)?.threadId).toBe("docs-1");
  });

  it("finds nothing without a selection or for a project with no thread", () => {
    expect(findSelectedTerminalTarget(targets, null)).toBeNull();
    expect(findSelectedTerminalTarget(targets, `${ENV}:empty`)).toBeNull();
  });
});
