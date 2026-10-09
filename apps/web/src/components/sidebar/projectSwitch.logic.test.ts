import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pickProjectSwitchThread } from "./projectSwitch.logic";

const env = "env-1" as EnvironmentId;

function thread(id: string, projectId: string, overrides: Record<string, unknown> = {}) {
  return {
    environmentId: env,
    id: id as ThreadId,
    projectId: projectId as ProjectId,
    archivedAt: null,
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestUserMessageAt: null,
    parentThreadId: null,
    kind: null,
    ...overrides,
  };
}

const key = (id: string) => scopedThreadKey(scopeThreadRef(env, id as ThreadId));
const members = new Set([`${env}:ninja`]);

describe("pickProjectSwitchThread", () => {
  const threads = [
    thread("other", "five", { latestUserMessageAt: "2026-10-09T00:00:00.000Z" }),
    thread("old", "ninja", { latestUserMessageAt: "2026-10-02T00:00:00.000Z" }),
    thread("busy", "ninja", { latestUserMessageAt: "2026-10-08T00:00:00.000Z" }),
    thread("child", "ninja", {
      latestUserMessageAt: "2026-10-09T00:00:00.000Z",
      parentThreadId: "busy",
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
});
