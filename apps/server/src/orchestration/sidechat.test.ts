import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { buildHandoff } from "./Handoff.ts";
import { findExpiredSidechats } from "./sidechatExpiry.ts";

const NOW = "2026-01-01T00:00:00.000Z";

const parent = {
  id: ThreadId.make("main"),
  projectId: ProjectId.make("project-1"),
  title: "main",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  pullRequests: [],
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  snoozedUntil: null,
  snoozedAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
} satisfies OrchestrationThread;

const readModel = {
  snapshotSequence: 0,
  projects: [
    {
      id: ProjectId.make("project-1"),
      title: "p",
      workspaceRoot: "/tmp/p",
      defaultModelSelection: null,
      scripts: [],
      createdAt: NOW,
      updatedAt: NOW,
      deletedAt: null,
    },
  ],
  threads: [parent],
  updatedAt: NOW,
} as unknown as OrchestrationReadModel;

it.layer(NodeServices.layer)("side chat commands", (it) => {
  it.effect("creating a side chat records its parent and kind", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.create",
          commandId: CommandId.make("cmd-create"),
          threadId: ThreadId.make("side"),
          projectId: ProjectId.make("project-1"),
          title: "Side chat",
          modelSelection: parent.modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: NOW,
          parentThreadId: parent.id,
          kind: "sidechat",
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0]! : result;
      expect(event.type).toBe("thread.created");
      expect(event.payload).toMatchObject({ parentThreadId: "main", kind: "sidechat" });
    }),
  );

  it.effect("promoting a side chat clears its kind", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.meta.update",
          commandId: CommandId.make("cmd-promote"),
          threadId: parent.id,
          kind: null,
        },
        readModel,
      });
      const event = Array.isArray(result) ? result[0]! : result;
      expect(event.type).toBe("thread.meta-updated");
      expect(event.payload).toMatchObject({ kind: null });
    }),
  );
});

describe("side chat handoff prelude", () => {
  it("frames the recap as read-only context for a quick question", () => {
    const handoff = buildHandoff({
      thread: {
        title: "main",
        messages: [
          {
            id: "m1",
            role: "user",
            text: "Refactor the auth store",
            turnId: null,
            streaming: false,
            createdAt: NOW,
            updatedAt: NOW,
          },
        ],
        activities: [],
      } as unknown as OrchestrationThread,
      from: { instanceId: "codex", model: "gpt-5.4" },
      to: { instanceId: "codex", model: "gpt-5.4" },
      recentExchanges: 3,
      sidechat: true,
    });
    const prelude = handoff.prelude(null);
    expect(prelude).toContain("side chat");
    expect(prelude).toContain("Refactor the auth store");
    expect(prelude).not.toContain("are taking over");
  });
});

describe("findExpiredSidechats", () => {
  const nowMs = Date.parse("2026-01-10T00:00:00.000Z");
  const shell = (overrides: Partial<OrchestrationThreadShell>) =>
    ({
      id: ThreadId.make("t"),
      kind: "sidechat",
      archivedAt: null,
      updatedAt: "2026-01-01T00:00:00.000Z",
      latestUserMessageAt: null,
      session: null,
      latestTurn: null,
      ...overrides,
    }) as OrchestrationThreadShell;

  it("expires idle side chats only", () => {
    const idle = shell({ id: ThreadId.make("idle") });
    const recent = shell({
      id: ThreadId.make("recent"),
      latestUserMessageAt: "2026-01-09T12:00:00.000Z",
    });
    const ordinary = shell({ id: ThreadId.make("ordinary"), kind: null });
    const archived = shell({ id: ThreadId.make("archived"), archivedAt: NOW });
    const working = shell({
      id: ThreadId.make("working"),
      session: { status: "running" } as OrchestrationThreadShell["session"],
    });
    expect(
      findExpiredSidechats([idle, recent, ordinary, archived, working], nowMs).map((t) => t.id),
    ).toEqual(["idle"]);
  });
});
