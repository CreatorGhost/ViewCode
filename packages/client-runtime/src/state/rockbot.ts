import { WS_METHODS, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import type { Atom } from "effect/reactivity";

import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * RockBot: the one chat over every project in an environment. It is an
 * ordinary thread with `kind: "orchestrator"`, opened from its own entry
 * rather than listed with the user's threads.
 */
export function isRockBot(thread: Pick<OrchestrationV2ThreadShell, "kind">): boolean {
  return thread.kind === "orchestrator";
}

export function createRockBotEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  return {
    /** Resolves to the environment's RockBot thread, creating it on first use. */
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:rockbot:open",
      tag: WS_METHODS.rockbotOpen,
      scheduler,
      // Two clicks before the first create returns still make one thread.
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
      },
    }),
  };
}
