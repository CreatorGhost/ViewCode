import type {
  OrchestrationCheckpointSummary,
  OrchestrationLatestTurn,
  OrchestrationMessage,
  OrchestrationProposedPlan,
  OrchestrationSession,
  OrchestrationThread,
  OrchestrationThreadActivity,
  ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import type { EnvironmentThread, EnvironmentThreadShell } from "./models.ts";
import { scopeThread } from "./models.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";
import { parseThreadKey, threadKey } from "./entities.ts";

const EMPTY_MESSAGES: ReadonlyArray<OrchestrationMessage> = Object.freeze([]);
const EMPTY_ACTIVITIES: ReadonlyArray<OrchestrationThreadActivity> = Object.freeze([]);
const EMPTY_PROPOSED_PLANS: ReadonlyArray<OrchestrationProposedPlan> = Object.freeze([]);
const EMPTY_CHECKPOINTS: ReadonlyArray<OrchestrationCheckpointSummary> = Object.freeze([]);

/**
 * Combine detail-only collections with the shell's authoritative thread metadata.
 *
 * Shell and detail subscriptions are intentionally independent. A cached detail can
 * therefore briefly outlive a newer shell snapshot after reconnecting. Workspace
 * consumers must use the shell branch/worktree/project fields so they do not target
 * a stale checkout while retaining messages, activities, plans, and checkpoints
 * from the detail subscription.
 */
export function mergeEnvironmentThread(
  detail: EnvironmentThread | null,
  shell: EnvironmentThreadShell | null,
): EnvironmentThread | null {
  if (detail === null || shell === null) {
    return detail;
  }
  if (detail.environmentId !== shell.environmentId || detail.id !== shell.id) {
    return detail;
  }

  return {
    ...detail,
    environmentId: shell.environmentId,
    id: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    modelSelection: shell.modelSelection,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    branch: shell.branch,
    worktreePath: shell.worktreePath,
    latestTurn: shell.latestTurn,
    createdAt: shell.createdAt,
    updatedAt: shell.updatedAt,
    archivedAt: shell.archivedAt,
    settledOverride: shell.settledOverride,
    settledAt: shell.settledAt,
    unsettledAt: shell.unsettledAt,
    activeOrderKey: shell.activeOrderKey,
    autoSettleDisabledAt: shell.autoSettleDisabledAt,
    parentThreadId: shell.parentThreadId ?? null,
    snoozedUntil: shell.snoozedUntil,
    snoozedAt: shell.snoozedAt,
    pinnedAt: shell.pinnedAt,
    pinOrderKey: shell.pinOrderKey,
    session: shell.session,
  };
}

const NO_UNDELIVERED_MESSAGES: ReadonlyMap<string, string> = new Map();

/**
 * User messages ViewCode cannot show reached the agent, keyed by message id,
 * with what the provider reported. A turn start that failed records the
 * message's id as its `requestId`; such a message is in ViewCode's history but
 * maybe not in the provider's session, which is what the agent resumes from.
 * Returns the same empty map when there are none, so callers can memoize on it.
 */
export function undeliveredUserMessages(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, string> {
  let undelivered: Map<string, string> | undefined;
  for (const activity of activities) {
    if (activity.kind !== "provider.turn.start.failed") continue;
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as { readonly requestId?: unknown; readonly detail?: unknown })
        : null;
    if (typeof payload?.requestId !== "string") continue;
    undelivered ??= new Map();
    undelivered.set(
      payload.requestId,
      typeof payload.detail === "string" ? payload.detail : activity.summary,
    );
  }
  return undelivered ?? NO_UNDELIVERED_MESSAGES;
}

export function createEnvironmentThreadDetailAtoms<E>(
  threadStateAtom: (
    environmentId: ScopedThreadRef["environmentId"],
    threadId: ScopedThreadRef["threadId"],
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const threadStateValueAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) =>
      Option.getOrElse(
        AsyncResult.value(get(threadStateAtom(ref.environmentId, ref.threadId))),
        () => EMPTY_ENVIRONMENT_THREAD_STATE,
      ),
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-state-value:${key}`));
  });

  const threadDetailAtomFamily = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previousSource: OrchestrationThread | null = null;
    let previousValue: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const source = Option.getOrNull(get(threadStateValueAtomFamily(key)).data);
      if (source === previousSource) {
        return previousValue;
      }
      previousSource = source;
      previousValue = source === null ? null : scopeThread(ref.environmentId, source);
      return previousValue;
    }).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-detail:${key}`));
  });

  const threadStatusAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).status).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-status:${key}`),
    ),
  );

  const threadErrorAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => Option.getOrNull(get(threadStateValueAtomFamily(key)).error)).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-error:${key}`),
    ),
  );

  const threadStalledAtomFamily = Atom.family((key: string) =>
    Atom.make((get) => get(threadStateValueAtomFamily(key)).stalled === true).pipe(
      Atom.setIdleTTL(0),
      Atom.withLabel(`environment-thread-stalled:${key}`),
    ),
  );

  const threadMessagesAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationMessage> =>
        get(threadDetailAtomFamily(key))?.messages ?? EMPTY_MESSAGES,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-messages:${key}`)),
  );

  const threadActivitiesAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationThreadActivity> =>
        get(threadDetailAtomFamily(key))?.activities ?? EMPTY_ACTIVITIES,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-activities:${key}`)),
  );

  const threadProposedPlansAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationProposedPlan> =>
        get(threadDetailAtomFamily(key))?.proposedPlans ?? EMPTY_PROPOSED_PLANS,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-proposed-plans:${key}`)),
  );

  const threadCheckpointsAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): ReadonlyArray<OrchestrationCheckpointSummary> =>
        get(threadDetailAtomFamily(key))?.checkpoints ?? EMPTY_CHECKPOINTS,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-checkpoints:${key}`)),
  );

  const threadSessionAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationSession | null => get(threadDetailAtomFamily(key))?.session ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-session:${key}`)),
  );

  const threadLatestTurnAtomFamily = Atom.family((key: string) =>
    Atom.make(
      (get): OrchestrationLatestTurn | null => get(threadDetailAtomFamily(key))?.latestTurn ?? null,
    ).pipe(Atom.setIdleTTL(0), Atom.withLabel(`environment-thread-latest-turn:${key}`)),
  );

  return {
    stateAtom: (ref: ScopedThreadRef) => threadStateValueAtomFamily(threadKey(ref)),
    detailAtom: (ref: ScopedThreadRef) => threadDetailAtomFamily(threadKey(ref)),
    statusAtom: (ref: ScopedThreadRef) => threadStatusAtomFamily(threadKey(ref)),
    errorAtom: (ref: ScopedThreadRef) => threadErrorAtomFamily(threadKey(ref)),
    stalledAtom: (ref: ScopedThreadRef) => threadStalledAtomFamily(threadKey(ref)),
    messagesAtom: (ref: ScopedThreadRef) => threadMessagesAtomFamily(threadKey(ref)),
    activitiesAtom: (ref: ScopedThreadRef) => threadActivitiesAtomFamily(threadKey(ref)),
    proposedPlansAtom: (ref: ScopedThreadRef) => threadProposedPlansAtomFamily(threadKey(ref)),
    checkpointsAtom: (ref: ScopedThreadRef) => threadCheckpointsAtomFamily(threadKey(ref)),
    sessionAtom: (ref: ScopedThreadRef) => threadSessionAtomFamily(threadKey(ref)),
    latestTurnAtom: (ref: ScopedThreadRef) => threadLatestTurnAtomFamily(threadKey(ref)),
  };
}
