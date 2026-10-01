import { useAtomValue } from "@effect/atom-react";
import { createAgentControlEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-control";
import type { AgentControlState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useMemo } from "react";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentControlEnvironment = createAgentControlEnvironmentAtoms(connectionAtomRuntime);

const EMPTY: ReadonlyMap<string, AgentControlState> = new Map();

/**
 * Paused agents and queued agent messages across environments, keyed by
 * `${environmentId}:${threadId}`. Environments whose server has no agent
 * control (the stream fails) or has not answered yet contribute nothing.
 */
const agentControlByThreadKeyAtom = Atom.family((environmentKey: string) =>
  Atom.make((get): ReadonlyMap<string, AgentControlState> => {
    if (environmentKey === "") return EMPTY;
    const byThreadKey = new Map<string, AgentControlState>();
    for (const environmentId of environmentKey.split("\n") as EnvironmentId[]) {
      const result = get(agentControlEnvironment.control({ environmentId, input: {} }));
      const states = Option.getOrUndefined(AsyncResult.value(result));
      for (const state of states ?? []) {
        byThreadKey.set(`${environmentId}:${state.threadId}`, state);
      }
    }
    return byThreadKey.size === 0 ? EMPTY : byThreadKey;
  }).pipe(Atom.withLabel(`mobile-agent-control:${environmentKey}`)),
);

export function useAgentControlByThreadKey(
  environmentIds: Iterable<EnvironmentId>,
): ReadonlyMap<string, AgentControlState> {
  const ids = [...environmentIds];
  ids.sort();
  const environmentKey = ids.join("\n");
  const atom = useMemo(() => agentControlByThreadKeyAtom(environmentKey), [environmentKey]);
  return useAtomValue(atom);
}
