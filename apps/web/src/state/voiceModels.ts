import { useAtomValue } from "@effect/atom-react";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  executeAtomQuery,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { createVoiceModelEnvironmentAtoms } from "@t3tools/client-runtime/state/voice-models";
import type { EnvironmentId, VoiceModelTier, VoiceModelsState } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { assetEnvironment } from "./assets";
import { primaryEnvironmentIdAtom } from "./primaryEnvironment";
import { readPreparedConnection } from "./session";

export const voiceModelEnvironment = createVoiceModelEnvironmentAtoms(connectionAtomRuntime);

/**
 * The environment that downloads and serves the natural read-aloud voice: the
 * one this app runs against, else the first saved environment.
 */
const readAloudEnvironmentIdAtom = Atom.make((get): EnvironmentId | null => {
  const primary = get(primaryEnvironmentIdAtom);
  if (primary !== null) return primary;
  for (const environmentId of get(environmentCatalog.catalogValueAtom).entries.keys()) {
    return environmentId;
  }
  return null;
}).pipe(Atom.withLabel("web-read-aloud-environment-id"));

export function useReadAloudEnvironmentId(): EnvironmentId | null {
  return useAtomValue(readAloudEnvironmentIdAtom);
}

export function readReadAloudEnvironmentId(): EnvironmentId | null {
  return appAtomRegistry.get(readAloudEnvironmentIdAtom);
}

const voiceModelsAtom = (environmentId: EnvironmentId) =>
  voiceModelEnvironment.state({ environmentId, input: {} });

type VoiceModelsResultAtom = Atom.Atom<AsyncResult.AsyncResult<VoiceModelsState, unknown>>;

const NO_VOICE_MODELS_ATOM: VoiceModelsResultAtom = Atom.make(
  AsyncResult.initial<VoiceModelsState, unknown>(true),
).pipe(Atom.withLabel("web-voice-models:none"));

/**
 * The environment's downloaded voice model tiers. `unavailable` when it has no
 * voice models (no environment, or a server from before them).
 */
export function useVoiceModels(environmentId: EnvironmentId | null): {
  readonly state: VoiceModelsState | null;
  readonly unavailable: boolean;
} {
  const atom: VoiceModelsResultAtom =
    environmentId === null ? NO_VOICE_MODELS_ATOM : voiceModelsAtom(environmentId);
  const result = useAtomValue(atom);
  return {
    state: Option.getOrNull(AsyncResult.value(result)),
    unavailable: environmentId === null || result._tag === "Failure",
  };
}

/** The tiers' state, waiting briefly for the first answer; null when the environment has none. */
export function readVoiceModels(
  environmentId: EnvironmentId,
  timeoutMs = 3_000,
): Promise<VoiceModelsState | null> {
  return new Promise((resolve) => {
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    const settle = (value: VoiceModelsState | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The subscription stays warm for its idle TTL, so the next press reads it at once.
      queueMicrotask(() => unsubscribe?.());
      resolve(value);
    };
    const timer = setTimeout(() => settle(null), timeoutMs);
    unsubscribe = appAtomRegistry.subscribe(
      voiceModelsAtom(environmentId),
      (result) => {
        if (result._tag === "Success") settle(result.value);
        else if (result._tag === "Failure") settle(null);
      },
      { immediate: true },
    );
    if (settled) unsubscribe();
  });
}

export function startVoiceModelDownload(environmentId: EnvironmentId, tier: VoiceModelTier) {
  return runAtomCommand(
    appAtomRegistry,
    voiceModelEnvironment.download,
    { environmentId, input: { tier } },
    { reportFailure: false },
  );
}

/**
 * A signed URL for the tier's directory on the environment; the speech worker
 * fetches `<url>/<path inside the model>`. Valid for an hour.
 */
export async function createVoiceModelBaseUrl(
  environmentId: EnvironmentId,
  tier: VoiceModelTier,
): Promise<string> {
  const connection = readPreparedConnection(environmentId);
  if (!connection) throw new Error("Not connected to the environment that has the voice.");
  const result = await executeAtomQuery(
    appAtomRegistry,
    assetEnvironment.createUrl({
      environmentId,
      input: { resource: { _tag: "voice-model", tier } },
    }),
    {
      label: "read-aloud:voice-model-url",
      reportFailure: false,
      reportDefect: false,
      refresh: true,
    },
  );
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(connection.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid voice URL.");
  return url.slice(0, url.lastIndexOf("/"));
}
