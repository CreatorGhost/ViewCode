import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThread as ThreadProjection } from "@t3tools/client-runtime/state/models";
import { scopeThread } from "@t3tools/client-runtime/viewcodeThread";
import {
  DEFAULT_SERVER_SETTINGS,
  type EnvironmentId,
  type ServerSettings,
  type SpeakMode,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { speakReadAloud } from "~/lib/readAloudPlayer";
import { createSpeakModeAutoplay } from "~/lib/speakMode.logic";
import { serverEnvironment } from "~/state/server";
import { getClientSettings, useUpdateEnvironmentSettings } from "./useSettings";

const noEnvironmentSettingsAtom = Atom.make<ServerSettings | null>(null);

/** Speak mode is a server setting: every client of an environment reads replies the same way. */
function useSpeakModeValue(environmentId: EnvironmentId | null): SpeakMode {
  const settings = useAtomValue(
    environmentId ? serverEnvironment.settingsValueAtom(environmentId) : noEnvironmentSettingsAtom,
  );
  return settings?.speakMode ?? DEFAULT_SERVER_SETTINGS.speakMode;
}

export function useSpeakMode(environmentId: EnvironmentId | null) {
  const mode = useSpeakModeValue(environmentId);
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  return { mode, setMode: (next: SpeakMode) => updateSettings({ speakMode: next }) };
}

/**
 * Reads each turn that completes in the thread on screen through the read-aloud player, as speak
 * mode asks. Off, the thread is not read at all; the first look after turning it on marks the
 * current turn as already heard (`createSpeakModeAutoplay`).
 */
export function useSpeakModeAutoplay(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadKey: string | null;
  readonly projection: ThreadProjection | null;
}): void {
  const mode = useSpeakModeValue(input.environmentId);
  const [observe] = useState(() =>
    createSpeakModeAutoplay((key, text) => speakReadAloud(key, text, getClientSettings())),
  );
  // Built only while speak mode is on, so a thread streaming with it off costs nothing here.
  const { projection, threadKey } = input;
  const thread =
    mode === "off" || projection === null
      ? null
      : scopeThread(projection.environmentId, projection.projection);
  useEffect(() => {
    observe({ threadKey, mode, thread });
  }, [observe, threadKey, mode, thread]);
}
