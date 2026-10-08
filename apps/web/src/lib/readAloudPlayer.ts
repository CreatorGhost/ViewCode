import type { ClientSettings, VoiceModelTier } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";
import { create } from "zustand";

import {
  createVoiceModelBaseUrl,
  readReadAloudEnvironmentId,
  readVoiceModels,
  startVoiceModelDownload,
} from "../state/voiceModels";
import {
  naturalVoiceStatus,
  planReadAloud,
  playChunksAhead,
  ReadAloudChunkError,
  type ReadAloudFallbackReason,
  readAloudChunks,
  resolveReadAloudVoice,
} from "./readAloud.logic";
import {
  closeKokoro,
  isKokoroSupported,
  type KokoroClip,
  synthesizeKokoro,
} from "./readAloudKokoro";

export interface ReadAloudSpeakOptions {
  /** A voice id of this engine, or null for the engine's default voice. */
  readonly voiceId: string | null;
  readonly rate: number;
  /** Called once when the last chunk finishes or speech fails. Not called after `stop`. */
  readonly onEnd: () => void;
}

/** The browser's speech queue, used for the system voice. */
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

/** Whether any voice can read here: the system voice or the natural one. */
export function isReadAloudSupported(): boolean {
  return systemSpeechEngine.isAvailable() || isKokoroSupported();
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

/** Why the last reply that wanted the natural voice got the system voice, shown beside its button. */
export interface ReadAloudNotice {
  readonly key: string;
  readonly reason: ReadAloudFallbackReason;
  readonly tier: VoiceModelTier;
}

/**
 * Which message is being read, as a `readAloudMessageKey`, or null. One player
 * per app. The notice outlives the reply so a download's progress stays in view.
 */
export const useReadAloudStore = create<{
  playingKey: string | null;
  notice: ReadAloudNotice | null;
}>(() => ({ playingKey: null, notice: null }));

let playback: { readonly generation: number; readonly stop: () => void } | null = null;
let generation = 0;
let pageHideListening = false;
let audioContext: AudioContext | null = null;

/** Readies Web Audio inside the click that asked for speech, as autoplay rules require. */
function wakeAudioContext(): AudioContext {
  audioContext ??= new AudioContext();
  void audioContext.resume();
  return audioContext;
}

/** Plays one clip; resolves when it ends or `signal` stops it. */
function playClip(context: AudioContext, clip: KokoroClip, signal: AbortSignal): Promise<void> {
  const buffer = context.createBuffer(1, clip.samples.length, clip.sampleRate);
  buffer.copyToChannel(clip.samples as Float32Array<ArrayBuffer>, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.connect(context.destination);
  return new Promise((resolve) => {
    const stop = () => source.stop();
    source.addEventListener("ended", () => {
      signal.removeEventListener("abort", stop);
      source.disconnect();
      resolve();
    });
    signal.addEventListener("abort", stop, { once: true });
    source.start();
  });
}

/** Reads `markdown` aloud, replacing anything already playing. */
export function speakReadAloud(
  key: string,
  markdown: string,
  settings: Pick<ClientSettings, "readAloudVoice" | "readAloudRate">,
): void {
  stopReadAloud();
  const voice = resolveReadAloudVoice(settings.readAloudVoice);
  const systemAvailable = systemSpeechEngine.isAvailable();
  const naturalSupported = voice.engine === "kokoro" && isKokoroSupported();
  if (!systemAvailable && !naturalSupported) return;
  const chunks = readAloudChunks(markdown);
  if (chunks.length === 0) return;
  if (!pageHideListening && typeof window !== "undefined") {
    pageHideListening = true;
    // Chromium keeps speaking across a reload unless the queue is cancelled.
    window.addEventListener("pagehide", stopReadAloud);
  }
  const current = (generation += 1);
  const controller = new AbortController();
  playback = {
    generation: current,
    stop: () => {
      controller.abort();
      systemSpeechEngine.stop();
      void audioContext?.suspend();
    },
  };
  useReadAloudStore.setState({ playingKey: key });
  const finish = () => {
    if (playback?.generation !== current) return;
    playback = null;
    void audioContext?.suspend();
    useReadAloudStore.setState({ playingKey: null });
  };
  const readWithSystemVoice = (from: ReadonlyArray<string>, voiceURI: string | null) => {
    if (!systemAvailable || from.length === 0) return finish();
    systemSpeechEngine.speak(from, {
      voiceId: voiceURI,
      rate: settings.readAloudRate,
      onEnd: finish,
    });
  };
  if (voice.engine === "system") return readWithSystemVoice(chunks, voice.voiceURI);

  const context = naturalSupported ? wakeAudioContext() : null;
  void (async () => {
    const environmentId = readReadAloudEnvironmentId();
    const models = context && environmentId ? await readVoiceModels(environmentId) : null;
    if (playback?.generation !== current) return;
    const plan = planReadAloud({
      voice,
      natural: naturalVoiceStatus(models, voice.tier),
      systemAvailable,
    });
    if (plan.startDownload && environmentId)
      void startVoiceModelDownload(environmentId, voice.tier);
    if (plan.notice) {
      useReadAloudStore.setState({ notice: { key, reason: plan.notice, tier: voice.tier } });
    }
    if (plan.engine !== "natural" || !context || !environmentId) {
      return readWithSystemVoice(chunks, null);
    }
    let modelBaseUrl: string;
    try {
      modelBaseUrl = await createVoiceModelBaseUrl(environmentId, voice.tier);
      if (playback?.generation !== current) return;
      await playChunksAhead(chunks, {
        synthesize: (text) =>
          synthesizeKokoro(
            { tier: voice.tier, modelBaseUrl },
            text,
            voice.voice,
            settings.readAloudRate,
          ),
        play: (clip, signal) => playClip(context, clip, signal),
        signal: controller.signal,
      });
      finish();
    } catch (error) {
      if (playback?.generation !== current) return;
      // Never silence: whatever the natural voice did not read, the system voice does.
      console.warn("The natural voice failed; reading with the system voice.", error);
      useReadAloudStore.setState({ notice: { key, reason: "error", tier: voice.tier } });
      readWithSystemVoice(
        chunks.slice(error instanceof ReadAloudChunkError ? error.chunkIndex : 0),
        null,
      );
    }
  })();
}

/** Stops reading and clears its notice. Touches no speech API when nothing is playing. */
export function stopReadAloud(): void {
  if (useReadAloudStore.getState().notice !== null) useReadAloudStore.setState({ notice: null });
  if (playback === null) return;
  const stopping = playback;
  playback = null;
  useReadAloudStore.setState({ playingKey: null });
  stopping.stop();
}

/** Frees the natural voice's memory, e.g. after its download is removed. */
export function unloadNaturalVoice(): void {
  stopReadAloud();
  closeKokoro();
}
