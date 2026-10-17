import type {
  OrchestrationThreadActivity,
  OrchestrationV2ThreadProjection,
  ScopedThreadRef,
} from "@t3tools/contracts";
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
export function undeliveredUserMessages(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyMap<string, string> {
  let result: Map<string, string> | undefined;
  for (const activity of activities) {
    if (activity.kind !== "provider.turn.start.failed") continue;
    const payload =
      typeof activity.payload === "object" && activity.payload !== null
        ? (activity.payload as { readonly requestId?: unknown; readonly detail?: unknown })
        : null;
    if (typeof payload?.requestId !== "string") continue;
    result ??= new Map();
    result.set(
      payload.requestId,
      typeof payload.detail === "string" ? payload.detail : activity.summary,
    );
  }
  return result ?? NO_UNDELIVERED_MESSAGES;
}
