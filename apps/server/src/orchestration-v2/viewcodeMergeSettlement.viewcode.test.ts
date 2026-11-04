// @effect-diagnostics nodeBuiltinImport:off - a read of this folder's own files, no Effect runtime.
/**
 * ViewCode guard: a merged pull request hands the thread back to its agent instead of settling it
 * (`viewcodeMergeSettlement.ts`). A merge used to settle the thread while the agent's own next
 * steps (re-run, deploy, verify) were still waiting for that merge.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import type * as ProjectionStore from "./ProjectionStore.ts";
import { resolveAutoSettlementDecision } from "./ThreadSettlementService.ts";
import { MERGE_WAKE_WINDOW_MS, mergeSettlementStep } from "./viewcodeMergeSettlement.ts";

const NOW_MS = Date.parse("2026-11-04T12:00:00.000Z");
const MINUTE_MS = 60 * 1_000;
const at = (offsetMs: number) => DateTime.makeUnsafe(NOW_MS + offsetMs);

/** An idle thread the user last wrote to two hours ago: only the fields settlement reads. */
function idleThread(latestRunCompletedAt: DateTime.Utc | null) {
  return {
    id: ThreadId.make("thread-1"),
    createdAt: at(-3 * 60 * MINUTE_MS),
    updatedAt: at(-60 * MINUTE_MS),
    archivedAt: null,
    settledOverride: null,
    pinnedAt: null,
    autoSettleDisabledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pendingRuntimeRequest: null,
    activityRunStatus: null,
    activityRunStartedAt: null,
    pendingBackgroundTasks: [],
    pullRequests: [],
    linkedPullRequest: null,
    branchPullRequest: null,
    latestRunId: null,
    latestRunRequestedAt: null,
    latestRunStartedAt: null,
    latestRunCompletedAt,
    latestUserMessageAt: at(-2 * 60 * MINUTE_MS),
    latestUserAuthoredMessageAt: at(-2 * 60 * MINUTE_MS),
    lastSnoozeWakeAt: null,
    status: "completed",
  } as unknown as ProjectionStore.ProjectionSettlementCandidate;
}

const decide = (latestRunCompletedAt: DateTime.Utc | null, mergedAtOffsetMs: number) =>
  resolveAutoSettlementDecision({
    thread: idleThread(latestRunCompletedAt),
    pullRequest: { state: "merged", mergedAt: DateTime.formatIso(at(mergedAtOffsetMs)) },
    nowMs: NOW_MS,
    autoSettleAfterDays: null,
    autoSettleOnMerge: true,
  });

describe("a merged pull request hands the thread back to its agent (ViewCode)", () => {
  it("wakes the agent when no run has ended since the merge", () => {
    expect(decide(at(-90 * MINUTE_MS), -60 * MINUTE_MS)).toEqual({
      kind: "wake-for-merge",
      mergedAtMs: NOW_MS - 60 * MINUTE_MS,
    });
  });

  it("settles once a run has ended after the merge", () => {
    expect(decide(at(-30 * MINUTE_MS), -60 * MINUTE_MS)).toEqual({
      kind: "settle",
      at: at(-30 * MINUTE_MS),
    });
  });

  it("settles a merge older than the wake window as before, so an update wakes no old threads", () => {
    expect(
      mergeSettlementStep({
        mergedAtMs: NOW_MS - MERGE_WAKE_WINDOW_MS - 1,
        latestRunCompletedAtMs: null,
        nowMs: NOW_MS,
      }),
    ).toBe("settle");
  });

  it("sends the wake through the settlement sweep, once per merge", () => {
    const service = NodeFS.readFileSync(
      NodePath.join(import.meta.dirname, "ThreadSettlementService.ts"),
      "utf8",
    );
    expect(service).toContain('decision.kind === "wake-for-merge"');
    expect(service).toContain("commandId: CommandId.make(`server:merge-wake:${key}`)");
  });
});
