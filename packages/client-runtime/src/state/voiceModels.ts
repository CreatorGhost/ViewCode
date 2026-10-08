import { WS_METHODS } from "@t3tools/contracts";
import type { Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";

/**
 * ViewCode read aloud: the natural voice's model tiers an environment has
 * downloaded, and the commands that download, cancel or remove them.
 */
export function createVoiceModelEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const concurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  return {
    state: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:voice-models:state",
      tag: WS_METHODS.subscribeVoiceModels,
    }),
    download: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice-models:download",
      tag: WS_METHODS.voiceModelsDownload,
      scheduler,
      concurrency,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice-models:cancel",
      tag: WS_METHODS.voiceModelsCancel,
      scheduler,
      concurrency,
    }),
    remove: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:voice-models:remove",
      tag: WS_METHODS.voiceModelsRemove,
      scheduler,
      concurrency,
    }),
  };
}
