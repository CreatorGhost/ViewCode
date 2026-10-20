import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { makeThreadFixture } from "../../test-fixtures";
import { describe, expect, it } from "vite-plus/test";

import { pickProjectSwitchThread } from "./projectSwitch.logic";

const env = EnvironmentId.make("env-1");

function thread(id: string, projectId: string, overrides: Partial<EnvironmentThreadShell> = {}) {
  return makeThreadFixture({
    environmentId: env,
    id: ThreadId.make(id),
    projectId: ProjectId.make(projectId),
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...overrides,
  });
}

const key = (id: string) => scopedThreadKey(scopeThreadRef(env, ThreadId.make(id)));
const members = new Set([`${env}:ninja`]);

describe("pickProjectSwitchThread", () => {
  const threads = [
    thread("other", "five", { latestUserMessageAt: "2026-10-09T00:00:00.000Z" }),
    thread("old", "ninja", { latestUserMessageAt: "2026-10-02T00:00:00.000Z" }),
    thread("busy", "ninja", { latestUserMessageAt: "2026-10-08T00:00:00.000Z" }),
    thread("child", "ninja", {
      latestUserMessageAt: "2026-10-09T00:00:00.000Z",
      lineage: {
        parentThreadId: ThreadId.make("busy"),
        rootThreadId: ThreadId.make("busy"),
        relationshipToParent: "subagent",
      },
    }),
    thread("gone", "ninja", { archivedAt: "2026-10-09T00:00:00.000Z" }),
  ];

  it("returns the folder's thread viewed most recently, then an open tab", () => {
    const pick = (recentThreadKeys: string[], openTabKeys: string[]) =>
      pickProjectSwitchThread({
        memberProjectKeys: members,
        threads,
        recentThreadKeys,
        openTabKeys,
      })?.id;
    expect(pick([key("other"), key("old"), key("busy")], [])).toBe("old");
    expect(pick([key("other")], [key("gone"), key("child")])).toBe("child");
  });

  it("falls back to the most recently active lead thread, never an archived one", () => {
    const picked = pickProjectSwitchThread({
      memberProjectKeys: members,
      threads,
      recentThreadKeys: [key("gone")],
      openTabKeys: [],
    });
    expect(picked?.id).toBe("busy");
  });

  it("leaving RockBot for All projects picks the user's latest work anywhere", () => {
    expect(
      pickProjectSwitchThread({
        memberProjectKeys: null,
        threads,
        recentThreadKeys: [],
        openTabKeys: [],
      })?.id,
    ).toBe("other");
  });

  it("returns null for a folder with no threads", () => {
    expect(
      pickProjectSwitchThread({
        memberProjectKeys: new Set([`${env}:empty`]),
        threads,
        recentThreadKeys: [],
        openTabKeys: [],
      }),
    ).toBeNull();
  });

  it("does not select a native side chat even when it is the most recently viewed thread", () => {
    const lead = thread("lead", "ninja");
    const shell = thread("sidechat", "ninja", {
      latestUserMessageAt: "2026-10-10T00:00:00.000Z",
      lineage: { parentThreadId: lead.id, rootThreadId: lead.id, relationshipToParent: "fork" },
    });
    const sidechat = { ...shell, source: { ...shell.source, kind: "sidechat" as const } };
    expect(
      pickProjectSwitchThread({
        memberProjectKeys: members,
        threads: [lead, sidechat],
        recentThreadKeys: [key("sidechat")],
        openTabKeys: [key("sidechat")],
      }),
    ).toBe(lead);
  });

  it("retains a deliberately viewed native child but never chooses it as a fallback lead", () => {
    const child = thread("child-only", "ninja", {
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        rootThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent",
      },
    });
    const pick = (recentThreadKeys: string[]) =>
      pickProjectSwitchThread({
        memberProjectKeys: members,
        threads: [child],
        recentThreadKeys,
        openTabKeys: [],
      });
    expect(pick([])).toBeNull();
    expect(pick([key("child-only")])).toBe(child);
  });
});
