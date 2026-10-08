import type { ClientSettings, ReadAloudVoice } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import { readAloudChunks } from "./readAloud.logic";

export interface ReadAloudSpeakOptions {
  /** A voice id of this engine, or null for the engine's default voice. */
  readonly voiceId: string | null;
  readonly rate: number;
  /** Called once when the last chunk finishes or speech fails. Not called after `stop`. */
  readonly onEnd: () => void;
}

/** A speech backend. The system voice is the only one today; a cloud voice would be another. */
export interface ReadAloudEngine {
  isAvailable(): boolean;
  speak(chunks: ReadonlyArray<string>, options: ReadAloudSpeakOptions): void;
  stop(): void;
}

function speechSynthesisApi(): SpeechSynthesis | null {
  return typeof globalThis.speechSynthesis === "object" &&
    typeof globalThis.SpeechSynthesisUtterance === "function"
    ? globalThis.speechSynthesis
    : null;
}

let systemGeneration = 0;
// Chromium can garbage-collect queued utterances and drop their events, so the
// current queue stays referenced until it ends.
let systemUtterances: SpeechSynthesisUtterance[] = [];

/** The browser's Web Speech voices (the Mac's own voices on macOS): offline and free. */
const systemSpeechEngine: ReadAloudEngine = {
  isAvailable: () => speechSynthesisApi() !== null,
  speak(chunks, { voiceId, rate, onEnd }) {
    const synth = speechSynthesisApi();
    if (!synth) return;
    systemSpeechEngine.stop();
    const generation = systemGeneration;
    const voice =
      voiceId === null ? undefined : synth.getVoices().find((each) => each.voiceURI === voiceId);
    const finish = () => {
      if (generation !== systemGeneration) return;
      systemSpeechEngine.stop();
      onEnd();
    };
    systemUtterances = chunks.map((chunk, index) => {
      const utterance = new SpeechSynthesisUtterance(chunk);
      if (voice) {
        utterance.voice = voice;
        utterance.lang = voice.lang;
      }
      utterance.rate = rate;
      // Cancelling fires `error` on queued utterances; the generation check ignores those.
      utterance.addEventListener("error", finish);
      if (index === chunks.length - 1) utterance.addEventListener("end", finish);
      return utterance;
    });
    for (const utterance of systemUtterances) synth.speak(utterance);
  },
  stop() {
    systemGeneration += 1;
    systemUtterances = [];
    speechSynthesisApi()?.cancel();
  },
};

const ENGINES: Record<ReadAloudVoice["engine"], ReadAloudEngine> = {
  system: systemSpeechEngine,
};

export function isReadAloudSupported(): boolean {
  return systemSpeechEngine.isAvailable();
}

const NO_VOICES: ReadonlyArray<SpeechSynthesisVoice> = [];
let systemVoices: ReadonlyArray<SpeechSynthesisVoice> | null = null;

function subscribeToSystemVoices(onChange: () => void): () => void {
  const synth = speechSynthesisApi();
  if (!synth) return () => {};
  const listener = () => {
    systemVoices = synth.getVoices();
    onChange();
  };
  synth.addEventListener("voiceschanged", listener);
  return () => synth.removeEventListener("voiceschanged", listener);
}

function systemVoicesSnapshot(): ReadonlyArray<SpeechSynthesisVoice> {
  // Chromium lists voices asynchronously: empty at first, then `voiceschanged`.
  systemVoices ??= speechSynthesisApi()?.getVoices() ?? NO_VOICES;
  return systemVoices;
}

/** The system voices, updating when the browser finishes loading them. */
export function useSystemVoices(): ReadonlyArray<SpeechSynthesisVoice> {
  return useSyncExternalStore(subscribeToSystemVoices, systemVoicesSnapshot, () => NO_VOICES);
}

/** Which message is being read, as a `readAloudMessageKey`, or null. One player per app. */
export const useReadAloudStore = create<{ playingKey: string | null }>(() => ({
  playingKey: null,
}));

let activeEngine: ReadAloudEngine | null = null;
let pageHideListening = false;

/** Reads `markdown` aloud, replacing anything already playing. */
export function speakReadAloud(
  key: string,
  markdown: string,
  settings: Pick<ClientSettings, "readAloudVoice" | "readAloudRate">,
): void {
  const engine = ENGINES[settings.readAloudVoice?.engine ?? "system"];
  if (!engine.isAvailable()) return;
  stopReadAloud();
  const chunks = readAloudChunks(markdown);
  if (chunks.length === 0) return;
  if (!pageHideListening && typeof window !== "undefined") {
    pageHideListening = true;
    // Chromium keeps speaking across a reload unless the queue is cancelled.
    window.addEventListener("pagehide", stopReadAloud);
  }
  activeEngine = engine;
  useReadAloudStore.setState({ playingKey: key });
  engine.speak(chunks, {
    voiceId: settings.readAloudVoice?.voiceURI ?? null,
    rate: settings.readAloudRate,
    onEnd: () => {
      if (activeEngine !== engine || useReadAloudStore.getState().playingKey !== key) return;
      activeEngine = null;
      useReadAloudStore.setState({ playingKey: null });
    },
  });
}

/** Stops reading. Does nothing (and touches no speech API) when nothing is playing. */
export function stopReadAloud(): void {
  if (activeEngine === null) return;
  const engine = activeEngine;
  activeEngine = null;
  useReadAloudStore.setState({ playingKey: null });
  engine.stop();
}
