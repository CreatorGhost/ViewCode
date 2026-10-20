import { describe, expect, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  agentSendHopsSinceUser,
  attentionItemFromShell,
  sortAttentionItems,
  THREAD_SEND_MAX_HOPS,
} from "./OrchestratorMcpService.ts";

const NOW = "2026-10-20T12:00:00.000Z";
const nowMs = DateTime.toEpochMillis(DateTime.makeUnsafe(NOW));
const at = (iso: string) => DateTime.makeUnsafe(iso);

function shell(id: string, overrides: Partial<OrchestrationV2ThreadShell> = {}) {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: `Thread ${id}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
    runtimeMode: "full-access",
    interactionMode: "default",
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestVisibleMessage: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    lastVisitedAt: null,
    deletedAt: null,
    branch: null,
    linkedPullRequest: null,
    status: "completed",
    activityRunStatus: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt: null,
    latestUserMessageAt: null,
    createdAt: at(NOW),
    updatedAt: at(NOW),
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    ...overrides,
  } satisfies OrchestrationV2ThreadShell;
}

const request = (kind: "user_input" | "command" | "dynamic_tool_call", createdAt: string) => ({
  id: RuntimeRequestId.make(`request-${createdAt}`),
  kind,
  createdAt: at(createdAt),
});

describe("attentionItemFromShell", () => {
  it("reports approvals and questions, even on a settled or snoozed thread", () => {
    expect(
      attentionItemFromShell(
        shell("asks", {
          status: "waiting",
          pendingRuntimeRequest: request("user_input", "2026-10-20T11:00:00.000Z"),
          settledOverride: "settled",
          snoozedUntil: at("2099-01-01T00:00:00.000Z"),
        }),
        nowMs,
      ),
    ).toMatchObject({
      attention: "question",
      since: "2026-10-20T11:00:00.000Z",
      link: "[Thread asks](t3-thread://v1/asks)",
    });
    expect(
      attentionItemFromShell(
        shell("approve", {
          status: "waiting",
          pendingRuntimeRequest: request("command", NOW),
        }),
        nowMs,
      )?.attention,
    ).toBe("approval");
  });

  it("treats a server-handled tool callback as work, not a need", () => {
    expect(
      attentionItemFromShell(
        shell("tool", {
          status: "running",
          latestRunStartedAt: at(NOW),
          pendingRuntimeRequest: request("dynamic_tool_call", NOW),
        }),
        nowMs,
      )?.attention,
    ).toBe("working");
  });

  it("reports failures with their error, but not once the user settled or snoozed them", () => {
    const failed = {
      status: "failed",
      lastError: "Provider crashed",
      latestRunCompletedAt: at(NOW),
    } as const;
    expect(attentionItemFromShell(shell("failed", failed), nowMs)).toMatchObject({
      attention: "failed",
      lastError: "Provider crashed",
    });
    expect(
      attentionItemFromShell(shell("settled", { ...failed, settledOverride: "settled" }), nowMs),
    ).toBeNull();
    expect(
      attentionItemFromShell(
        shell("snoozed", {
          ...failed,
          snoozedAt: at("2026-10-20T12:30:00.000Z"),
          snoozedUntil: at("2099-01-01T00:00:00.000Z"),
        }),
        nowMs,
      ),
    ).toBeNull();
  });

  it("leaves finished and idle threads out", () => {
    expect(attentionItemFromShell(shell("done"), nowMs)).toBeNull();
    expect(attentionItemFromShell(shell("idle", { status: "idle" }), nowMs)).toBeNull();
  });
});

describe("sortAttentionItems", () => {
  it("puts needs first, longest waiting first, then failures and work newest first", () => {
    const items = [
      shell("working-old", { status: "running", latestRunStartedAt: at("2026-10-20T09:00:00Z") }),
      shell("failed", { status: "failed", latestRunCompletedAt: at("2026-10-20T10:00:00Z") }),
      shell("asks-new", {
        status: "waiting",
        pendingRuntimeRequest: request("user_input", "2026-10-20T11:30:00.000Z"),
      }),
      shell("working-new", { status: "running", latestRunStartedAt: at("2026-10-20T11:00:00Z") }),
      shell("approve-old", {
        status: "waiting",
        pendingRuntimeRequest: request("command", "2026-10-20T08:00:00.000Z"),
      }),
    ].flatMap((thread) => attentionItemFromShell(thread, nowMs) ?? []);
    expect(sortAttentionItems(items).map((item) => item.threadId)).toEqual([
      "approve-old",
      "asks-new",
      "failed",
      "working-new",
      "working-old",
    ]);
  });
});

describe("agentSendHopsSinceUser", () => {
  const other = ThreadId.make("other");
  const message = (createdAt: string, from: "user" | "thread" | "wake") => ({
    createdBy: from === "user" ? ("user" as const) : ("agent" as const),
    ...(from === "thread" ? { senderThreadId: other } : {}),
    createdAt: at(createdAt),
  });

  it("counts sends from other threads since the user last wrote", () => {
    expect(
      agentSendHopsSinceUser([
        message("2026-10-20T10:00:00Z", "thread"),
        message("2026-10-20T10:01:00Z", "user"),
        message("2026-10-20T10:03:00Z", "thread"),
        message("2026-10-20T10:02:00Z", "wake"),
        message("2026-10-20T10:04:00Z", "thread"),
      ]),
    ).toBe(2);
  });

  it("reaches the limit in a ping-pong the user never interrupts", () => {
    const pingPong = Array.from({ length: THREAD_SEND_MAX_HOPS }, (_, index) =>
      message(DateTime.formatIso(DateTime.makeUnsafe(nowMs + (index + 1) * 1000)), "thread"),
    );
    expect(agentSendHopsSinceUser([message(NOW, "user"), ...pingPong])).toBe(THREAD_SEND_MAX_HOPS);
  });
});
