import type { OrchestrationV2ThreadProjection, ScopedThreadRef } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "./state/entities.ts";
import { createEnvironmentThreadDetailAtoms } from "./state/threadDetail.ts";
import { createEnvironmentThreadShellAtoms } from "./state/threadShell.ts";
import { type EnvironmentThreadState as NativeThreadState } from "./state/threadState.ts";
import {
  scopeThread,
  scopeThreadShell,
  viewCodeThread,
  type EnvironmentThread,
  type EnvironmentThreadShell,
  type OrchestrationMessage,
  type ViewCodeThread,
} from "./viewcodeThread.ts";

export interface EnvironmentThreadState extends Omit<NativeThreadState, "data"> {
  readonly data: Option.Option<ViewCodeThread>;
  readonly page: Option.Option<{
    readonly beforeCursor: string | null;
    readonly hasMore: boolean;
    readonly loadingOlder: boolean;
  }>;
  readonly stalled?: true;
}

const presentedThreads = new WeakMap<OrchestrationV2ThreadProjection, ViewCodeThread>();

const presentedStates = new WeakMap<NativeThreadState, EnvironmentThreadState>();

export function viewCodeThreadState(state: NativeThreadState): EnvironmentThreadState {
  const cached = presentedStates.get(state);
  if (cached !== undefined) return cached;
  const result: EnvironmentThreadState = {
    ...state,
    data: Option.map(state.data, (projection) => {
      let thread = presentedThreads.get(projection);
      if (thread === undefined) {
        thread = viewCodeThread(projection);
        presentedThreads.set(projection, thread);
      }
      return thread;
    }),
    page: Option.some({
      beforeCursor: state.history.historyCursor,
      hasMore: state.history.hasMoreHistory,
      loadingOlder: state.history.loading,
    }),
  };
  presentedStates.set(state, result);
  return result;
}

export function threadHasOlderTurns(state: EnvironmentThreadState): boolean {
  return state.history.hasMoreHistory;
}

export function createViewCodeThreadDetailAtoms<E>(
  input: Parameters<typeof createEnvironmentThreadDetailAtoms<E>>[0],
) {
  const native = createEnvironmentThreadDetailAtoms(input);
  const threads = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    let previous: ReturnType<typeof native.threadAtom> extends Atom.Atom<infer A> ? A : never =
      null;
    let presented: EnvironmentThread | null = null;
    return Atom.make((get) => {
      const value = get(native.threadAtom(ref));
      if (value !== previous) {
        previous = value;
        presented = value === null ? null : scopeThread(value.environmentId, value.projection);
      }
      return presented;
    }).pipe(Atom.setIdleTTL(0));
  });
  const select = <A>(read: (thread: EnvironmentThread | null) => A) =>
    Atom.family((key: string) =>
      Atom.make((get) => read(get(threads(key)))).pipe(Atom.setIdleTTL(0)),
    );
  const activities = select((thread) => thread?.activities ?? []);
  const messages = select((thread) => thread?.messages ?? []);
  const plans = select((thread) => thread?.proposedPlans ?? []);
  const checkpoints = select((thread) => thread?.checkpoints ?? []);
  const states = Atom.family((key: string) =>
    Atom.make((get) => viewCodeThreadState(get(native.stateAtom(parseThreadKey(key))))).pipe(
      Atom.setIdleTTL(0),
    ),
  );
  return {
    ...native,
    threadAtom: (ref: ScopedThreadRef) => threads(threadKey(ref)),
    stateAtom: (ref: ScopedThreadRef) => states(threadKey(ref)),
    activitiesAtom: (ref: ScopedThreadRef) => activities(threadKey(ref)),
    messagesAtom: (ref: ScopedThreadRef) => messages(threadKey(ref)),
    proposedPlansAtom: (ref: ScopedThreadRef) => plans(threadKey(ref)),
    checkpointsAtom: (ref: ScopedThreadRef) => checkpoints(threadKey(ref)),
  };
}

export function createViewCodeThreadShellAtoms(
  input: Parameters<typeof createEnvironmentThreadShellAtoms>[0],
) {
  const native = createEnvironmentThreadShellAtoms(input);
  type NativeShell =
    ReturnType<typeof native.threadShellAtom> extends Atom.Atom<infer A> ? NonNullable<A> : never;
  const shells = new WeakMap<NativeShell, EnvironmentThreadShell>();
  const present = (value: NativeShell): EnvironmentThreadShell => {
    let result = shells.get(value);
    if (result === undefined) {
      result = scopeThreadShell(value.environmentId, value.source);
      shells.set(value, result);
    }
    return result;
  };
  const lists = new WeakMap<
    Atom.Atom<ReadonlyArray<NativeShell>>,
    Atom.Atom<ReadonlyArray<EnvironmentThreadShell>>
  >();
  const presentList = (source: Atom.Atom<ReadonlyArray<NativeShell>>) => {
    let atom = lists.get(source);
    if (atom === undefined) {
      atom = Atom.make((get) => get(source).map(present));
      lists.set(source, atom);
    }
    return atom;
  };
  const byRef = Atom.family((key: string) =>
    Atom.make((get) => {
      const shell = get(native.threadShellAtom(parseThreadKey(key)));
      return shell === null ? null : present(shell);
    }),
  );
  return {
    ...native,
    nativeThreadShellsAtom: native.threadShellsAtom,
    threadShellsAtom: presentList(native.threadShellsAtom),
    navigationThreadShellsAtom: presentList(native.navigationThreadShellsAtom),
    threadShellAtom: (ref: ScopedThreadRef) => byRef(threadKey(ref)),
    threadShellsForProjectRefsAtom: (
      refs: Parameters<typeof native.threadShellsForProjectRefsAtom>[0],
    ) => presentList(native.threadShellsForProjectRefsAtom(refs)),
  };
}

export function mergeEnvironmentThread(
  detail: EnvironmentThread | null,
  shell: EnvironmentThreadShell | null,
): EnvironmentThread | null {
  if (
    detail === null ||
    shell === null ||
    detail.id !== shell.id ||
    detail.environmentId !== shell.environmentId
  )
    return detail;
  return {
    ...detail,
    ...shell,
    messages: detail.messages,
    activities: detail.activities,
    proposedPlans: detail.proposedPlans,
    checkpoints: detail.checkpoints,
    deletedAt: detail.deletedAt,
    projection: detail.projection,
  };
}

export function threadImagePayloadBytes(messages: ReadonlyArray<OrchestrationMessage>): number {
  return messages.reduce(
    (total, message) =>
      total +
      (message.attachments ?? []).reduce(
        (sum, attachment) => sum + (attachment.type === "image" ? attachment.sizeBytes : 0),
        0,
      ),
    0,
  );
}

const NO_UNDELIVERED_MESSAGES: ReadonlyMap<string, string> = new Map();
const UNDELIVERED_RUN_REASON = "The provider never started a turn for this message.";

/**
 * Sent user messages the provider never received, keyed by message id, with the
 * failure the run reported. A run that failed before its provider started a turn
 * (a refused turn start, or a failed run preparation) has no provider turn; its
 * message is in ViewCode's history but not in the provider's session, which is
 * what the agent resumes from. Only a message's latest run counts, so a retry
 * that got through clears it. Returns one shared empty map when there is none.
 */
export function undeliveredRunMessages(
  projection: Pick<
    OrchestrationV2ThreadProjection,
    "runs" | "attempts" | "providerTurns" | "turnItems"
  >,
): ReadonlyMap<string, string> {
  const latestRunByMessage = new Map<string, OrchestrationV2ThreadProjection["runs"][number]>();
  for (const run of projection.runs) {
    const latest = latestRunByMessage.get(run.userMessageId);
    if (latest === undefined || run.ordinal > latest.ordinal)
      latestRunByMessage.set(run.userMessageId, run);
  }
  let result: Map<string, string> | undefined;
  for (const [messageId, run] of latestRunByMessage) {
    if (run.status !== "failed") continue;
    const attempts = projection.attempts.filter((attempt) => attempt.runId === run.id);
    const started = projection.providerTurns.some((turn) =>
      attempts.some(
        (attempt) => turn.runAttemptId === attempt.id || turn.id === attempt.providerTurnId,
      ),
    );
    if (started) continue;
    const failure = projection.turnItems.findLast(
      (item) => item.type === "error" && item.runId === run.id,
    );
    result ??= new Map();
    result.set(
      messageId,
      failure?.type === "error" ? failure.failure.message : UNDELIVERED_RUN_REASON,
    );
  }
  return result ?? NO_UNDELIVERED_MESSAGES;
}
