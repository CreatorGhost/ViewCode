import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * ViewCode agent control: stop an agent tree, resume a paused agent, discard
 * its held messages, and the live paused/queued state of every agent.
 */
export function createAgentControlEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  // One queue per environment so Stop, Resume and Discard apply in click order.
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    stop: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:stop",
      tag: WS_METHODS.agentsStop,
      scheduler,
      concurrency,
    }),
    resume: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:resume",
      tag: WS_METHODS.agentsResume,
      scheduler,
      concurrency,
    }),
    discard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:agents:discard",
      tag: WS_METHODS.agentsDiscard,
      scheduler,
      concurrency,
    }),
    /** Agents that are paused or hold queued messages; empty when none. */
    control: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:agents:control",
      tag: WS_METHODS.subscribeAgentControl,
    }),
  };
}
