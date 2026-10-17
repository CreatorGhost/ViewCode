import {
  createViewCodeThreadDetailAtoms as createEnvironmentThreadDetailAtoms,
  createViewCodeThreadShellAtoms as createEnvironmentThreadShellAtoms,
  viewCodeThreadState,
  type EnvironmentThreadState,
} from "@t3tools/client-runtime/viewcodeThreadAtoms";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useAtomValue } from "@effect/atom-react";
import {
  createEnvironmentThreadStateAtoms,
  EMPTY_ENVIRONMENT_THREAD_STATE,
  createThreadEnvironmentAtoms,
} from "@t3tools/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSnapshotAtom } from "./shell";

export const threadEnvironment = createThreadEnvironmentAtoms(
  connectionAtomRuntime,
  environmentSnapshotAtom,
);
export const environmentThreads = createEnvironmentThreadStateAtoms(connectionAtomRuntime);
export const environmentThreadDetails = createEnvironmentThreadDetailAtoms(
  environmentThreads.stateAtom,
);
export const environmentThreadShells = createEnvironmentThreadShellAtoms({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  snapshotAtom: threadEnvironment.snapshotAtom,
});

const EMPTY_THREAD_STATE_ATOM = Atom.make(AsyncResult.success(EMPTY_ENVIRONMENT_THREAD_STATE)).pipe(
  Atom.withLabel("mobile-environment-thread:empty"),
);

export function useEnvironmentThread(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): EnvironmentThreadState {
  const result = useAtomValue(
    environmentId !== null && threadId !== null
      ? environmentThreads.stateAtom(environmentId, threadId)
      : EMPTY_THREAD_STATE_ATOM,
  );
  return viewCodeThreadState(
    Option.getOrElse(AsyncResult.value(result), () => EMPTY_ENVIRONMENT_THREAD_STATE),
  );
}

export function requestOlderThreadTurns(environmentId: EnvironmentId, threadId: ThreadId): void {
  void runAtomCommand(appAtomRegistry, threadEnvironment.loadEarlierHistory, {
    environmentId,
    input: { threadId },
  });
}
