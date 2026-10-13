import type { OrchestrationThreadShell } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export interface SettlementPullRequest {
  readonly state: "open" | "closed" | "merged";
  readonly closedAt?: string | null;
  readonly mergedAt?: string | null;
  readonly updatedAt?: string | null;
}

/** Bounds malformed or unexpectedly deep agent trees; reaching the cap blocks settlement. */
export const MAX_SETTLEMENT_AGENT_DEPTH = 64;

type QueuedTurnState = {
  readonly latestUserMessageAt: OrchestrationThreadShell["latestUserMessageAt"];
  readonly session: Pick<NonNullable<OrchestrationThreadShell["session"]>, "status"> | null;
  readonly latestTurn: Pick<
    NonNullable<OrchestrationThreadShell["latestTurn"]>,
    "requestedAt" | "startedAt" | "completedAt"
  > | null;
};

export type SettlementAgentState = QueuedTurnState &
  Pick<
    OrchestrationThreadShell,
    | "id"
    | "parentThreadId"
    | "kind"
    | "archivedAt"
    | "settledOverride"
    | "settledAt"
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "backgroundLiveness"
  >;

export type SettlementAgentTree = ReadonlyMap<
  string | null | undefined,
  ReadonlyArray<SettlementAgentState>
>;

const DAY_MS = 24 * 60 * 60 * 1_000;
const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

function latestTimestamp(values: ReadonlyArray<string | null | undefined>): string | null {
  let latest: string | null = null;
  let latestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (value == null) continue;
    const valueMs = Date.parse(value);
    if (valueMs > latestMs) {
      latest = value;
      latestMs = valueMs;
    }
  }
  return latest;
}

/** A recent user message stays queued until a turn adopts its timestamp.
 * Absolute age bounds client clock skew in both directions and stops stale
 * pre-adoption data from blocking the thread forever. */
export function threadHasQueuedTurnStart(thread: QueuedTurnState, now: string): boolean {
  if (thread.latestUserMessageAt === null || thread.session?.status === "error") return false;
  const messageAt = Date.parse(thread.latestUserMessageAt);
  const age = Date.parse(now) - messageAt;
  if (Number.isNaN(age) || Math.abs(age) > QUEUED_TURN_START_GRACE_MS) return false;
  if (thread.latestTurn === null) return true;
  return [
    thread.latestTurn.requestedAt,
    thread.latestTurn.startedAt,
    thread.latestTurn.completedAt,
  ].every((value) => value == null || Date.parse(value) < messageAt);
}

function pullRequestSettles(
  thread: Pick<OrchestrationThreadShell, "createdAt" | "latestUserMessageAt" | "latestTurn">,
  pullRequest: SettlementPullRequest,
  autoSettleOnMerge: boolean,
): boolean {
  if (pullRequest.state !== "closed" && (pullRequest.state !== "merged" || !autoSettleOnMerge)) {
    return false;
  }
  const terminalAt = pullRequest.state === "merged" ? pullRequest.mergedAt : pullRequest.closedAt;
  if (terminalAt == null) return false;
  const userAnchor = latestTimestamp([
    thread.createdAt,
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
  ]);
  if (userAnchor === null) return false;
  const pullRequestAt = Date.parse(terminalAt);
  const userAnchorAt = Date.parse(userAnchor);
  if (Number.isNaN(pullRequestAt) || Number.isNaN(userAnchorAt)) return false;
  return pullRequestAt >= userAnchorAt;
}

export function resolveAutoSettlementAt(input: {
  readonly thread: OrchestrationThreadShell;
  readonly agentTree?: SettlementAgentTree;
  readonly pullRequest: SettlementPullRequest | null;
  readonly now: string;
  readonly autoSettleAfterDays: number | null;
  readonly autoSettleOnMerge: boolean;
}): string | null {
  const { thread } = input;
  let pullRequest = input.pullRequest;
  const links = visibleThreadPullRequests(thread.pullRequests);
  if (links.some((link) => link.snapshot === null || link.snapshot.state === "open")) return null;
  if (links.length > 0) {
    const terminalTimestamp = (link: (typeof links)[number]) => {
      const snapshot = link.snapshot;
      const value = snapshot?.state === "merged" ? snapshot.mergedAt : snapshot?.closedAt;
      const timestamp = Date.parse(value ?? "");
      return Number.isNaN(timestamp) ? Number.NEGATIVE_INFINITY : timestamp;
    };
    const latest = links.reduce((current, candidate) =>
      terminalTimestamp(candidate) > terminalTimestamp(current) ? candidate : current,
    );
    pullRequest =
      latest.snapshot === null
        ? null
        : {
            state: latest.snapshot.state,
            mergedAt: latest.snapshot.mergedAt ?? null,
            closedAt: latest.snapshot.closedAt ?? null,
          };
  }
  if (!isAutoSettlementCandidate(thread, input.now, input.agentTree)) return null;
  const activityAt = latestTimestamp([
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ]);
  if (pullRequest !== null) {
    if (pullRequestSettles(thread, pullRequest, input.autoSettleOnMerge)) {
      return activityAt ?? thread.createdAt;
    }
  }
  if (input.autoSettleAfterDays === null || activityAt === null) return null;
  return Date.parse(activityAt) < Date.parse(input.now) - input.autoSettleAfterDays * DAY_MS
    ? activityAt
    : null;
}

/** Unsettled descendant work keeps its lead visible; settled subtrees and side chats stop the walk. */
export function threadHasActiveDescendantAgent(
  thread: Pick<OrchestrationThreadShell, "id">,
  agentTree: SettlementAgentTree,
  now: string,
): boolean {
  const seen = new Set<string>([thread.id]);
  const queue = [{ id: thread.id, depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    const parent = queue[index]!;
    for (const child of agentTree.get(parent.id) ?? []) {
      if (
        seen.has(child.id) ||
        child.kind === "sidechat" ||
        child.archivedAt !== null ||
        child.settledOverride === "settled" ||
        child.settledAt !== null
      )
        continue;
      seen.add(child.id);
      if (
        child.hasPendingApprovals ||
        child.hasPendingUserInput ||
        child.session?.status === "starting" ||
        child.session?.status === "running" ||
        child.backgroundLiveness != null ||
        threadHasQueuedTurnStart(child, now)
      )
        return true;
      // Fail closed at the limit rather than hiding work beyond it.
      if (parent.depth + 1 >= MAX_SETTLEMENT_AGENT_DEPTH) return true;
      queue.push({ id: child.id, depth: parent.depth + 1 });
    }
  }
  return false;
}

/** Cheap checks that run before any source control lookup. */
export function isAutoSettlementCandidate(
  thread: OrchestrationThreadShell,
  now: string,
  agentTree: SettlementAgentTree = new Map(),
): boolean {
  if (thread.archivedAt !== null || thread.settledOverride !== null) return false;
  if (thread.autoSettleDisabledAt != null) return false;
  if (threadHasActiveDescendantAgent(thread, agentTree, now)) return false;
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return false;
  if (thread.backgroundLiveness != null) return false;
  if (threadHasQueuedTurnStart(thread, now)) return false;
  if (thread.snoozedUntil == null || Date.parse(thread.snoozedUntil) <= Date.parse(now))
    return true;
  const wokeOnError =
    thread.session?.status === "error" &&
    (thread.snoozedAt == null ||
      Date.parse(thread.session.updatedAt) > Date.parse(thread.snoozedAt));
  const wokeOnCompletion =
    thread.snoozedAt != null &&
    thread.latestTurn?.state === "completed" &&
    thread.latestTurn.completedAt != null &&
    Date.parse(thread.latestTurn.completedAt) > Date.parse(thread.snoozedAt);
  return wokeOnError || wokeOnCompletion;
}
