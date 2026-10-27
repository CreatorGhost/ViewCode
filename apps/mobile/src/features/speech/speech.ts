import * as Speech from "expo-speech";
import { useSyncExternalStore } from "react";
import { AppState } from "react-native";

import { speechChunks } from "./speakableText";

/** One utterance at a time, app-wide; its key says which reply is being read. */
let speakingKey: string | null = null;
// Each speak() bumps this, so callbacks from a stopped utterance are ignored.
let generation = 0;
const listeners = new Set<() => void>();

function setSpeakingKey(key: string | null) {
  if (speakingKey === key) return;
  speakingKey = key;
  for (const listener of listeners) listener();
}

export function speak(key: string, text: string) {
  const chunks = speechChunks(text);
  void Speech.stop();
  const current = ++generation;
  if (chunks.length === 0 || AppState.currentState !== "active") {
    setSpeakingKey(null);
    return;
  }
  setSpeakingKey(key);
  const finish = () => {
    if (generation === current) setSpeakingKey(null);
  };
  chunks.forEach((chunk, index) => {
    Speech.speak(chunk, {
      onDone: index === chunks.length - 1 ? finish : undefined,
      onStopped: finish,
      onError: finish,
    });
  });
}

export function stopSpeaking() {
  generation += 1;
  setSpeakingKey(null);
  void Speech.stop();
}

/** Stops only if `key` is what is being read. */
export function stopSpeakingIf(predicate: (key: string) => boolean) {
  if (speakingKey !== null && predicate(speakingKey)) stopSpeaking();
}

export function useSpeakingKey(): string | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => speakingKey,
  );
}

// Nothing is ever read while the app is in the background.
AppState.addEventListener("change", (state) => {
  if (state !== "active") stopSpeaking();
});
