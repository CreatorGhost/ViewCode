import { useAtomValue } from "@effect/atom-react";
import { createAgentControlEnvironmentAtoms } from "@t3tools/client-runtime/state/agent-control";
import type { AgentControlState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const agentControlEnvironment = createAgentControlEnvironmentAtoms(connectionAtomRuntime);

const EMPTY: ReadonlyMap<string, AgentControlState> = new Map();

/**
 * Paused agents and queued agent messages by thread id. Empty until the
 * server answers, and on servers without agent control (the stream fails).
 */
const environmentAgentControlAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyMap<string, AgentControlState> => {
    const result = get(agentControlEnvironment.control({ environmentId, input: {} }));
    return Option.match(AsyncResult.value(result), {
      onNone: () => EMPTY,
      onSome: (states) => new Map(states.map((state) => [String(state.threadId), state])),
    });
  }).pipe(Atom.withLabel(`web-agent-control:${environmentId}`)),
);

export function useAgentControl(
  environmentId: EnvironmentId,
): ReadonlyMap<string, AgentControlState> {
  return useAtomValue(environmentAgentControlAtom(environmentId));
}
