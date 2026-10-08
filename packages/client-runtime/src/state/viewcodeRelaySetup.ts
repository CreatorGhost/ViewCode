import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createAtomCommandScheduler, createEnvironmentRpcCommand } from "./runtime.ts";

/**
 * ViewCode Quick connect setup commands. Progress arrives on the auth access
 * stream as `viewcodeRelaySetup`, so there is nothing to subscribe to here.
 */
export function createViewCodeRelaySetupAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:viewcode-relay:setup-start",
      tag: WS_METHODS.viewcodeRelaySetupStart,
      scheduler,
      concurrency,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:viewcode-relay:setup-cancel",
      tag: WS_METHODS.viewcodeRelaySetupCancel,
      scheduler,
      concurrency,
    }),
    continueSetup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:viewcode-relay:setup-continue",
      tag: WS_METHODS.viewcodeRelaySetupContinue,
      scheduler,
      concurrency,
    }),
    chooseAccount: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:viewcode-relay:setup-choose-account",
      tag: WS_METHODS.viewcodeRelaySetupChooseAccount,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:viewcode-relay:remove",
      tag: WS_METHODS.viewcodeRelayRemove,
      scheduler,
      concurrency,
    }),
  };
}
