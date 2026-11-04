// One dictation at a time, app-wide: the composer that started it owns it and
// gets the transcript when the user confirms. The waveform listens to levels
// directly so the 20 bars a second never re-render React.
import { DICTATION_MODEL_KEY, type EnvironmentId, type VoiceModelsState } from "@t3tools/contracts";
import { create } from "zustand";

import {
  createVoiceModelBaseUrl,
  readReadAloudEnvironmentId,
  readVoiceModels,
  startVoiceModelDownload,
  subscribeVoiceModels,
} from "../state/voiceModels";
import {
  DICTATION_IDLE,
  type DictationErrorReason,
  type DictationEvent,
  type DictationSegment,
  DictationSegmenter,
  type DictationState,
  type TranscriptPart,
  dictationReducer,
  joinTranscript,
} from "./dictation.logic";
import { DICTATION_FRAME_MS } from "./dictationAudio";
import {
  type DictationCapture,
  DictationCaptureError,
  isDictationSupported,
  openDictationCapture,
} from "./dictationCapture";
import { isDictationModelLoaded, loadDictationModel, transcribeDictation } from "./dictationModel";

/** Dictation stops listening after this long and keeps what it heard, as on mobile. */
const DICTATION_LIMIT_MS = 5 * 60_000;
/** The open utterance is re-read once it has grown by this much audio. */
const PARTIAL_STEP_FRAMES = Math.round(600 / DICTATION_FRAME_MS);

export interface DictationStore {
  /** The composer that owns the running dictation, or null. */
  readonly ownerKey: string | null;
  readonly state: DictationState;
  /** Everything heard so far, as the model last read it. */
  readonly transcript: string;
}

export const useDictationStore = create<DictationStore>(() => ({
  ownerKey: null,
  state: DICTATION_IDLE,
  transcript: "",
}));

const levelListeners = new Set<(level: number) => void>();

/** Hears the microphone level of every 50 ms frame while dictation listens. */
export function subscribeDictationLevels(listener: (level: number) => void): () => void {
  levelListeners.add(listener);
  return () => levelListeners.delete(listener);
}

interface Session {
  readonly ownerKey: string;
  readonly onCommit: (text: string) => void;
  readonly segmenter: DictationSegmenter;
  /** Finished utterances waiting for the model, oldest first. */
  readonly queued: DictationSegment[];
  /** Transcripts of finished utterances, in order. */
  readonly finals: TranscriptPart[];
  partial: (TranscriptPart & { readonly segmentId: number }) | null;
  partialFrames: number;
  capture: DictationCapture | null;
  modelReady: boolean;
  transcribing: boolean;
  confirmed: boolean;
  ended: boolean;
  limitTimer: ReturnType<typeof setTimeout> | null;
  stopWatchingModels: (() => void) | null;
}

let session: Session | null = null;

function dispatch(event: DictationEvent): void {
  useDictationStore.setState((store) => ({ state: dictationReducer(store.state, event) }));
}

function publishTranscript(current: Session): void {
  const parts: TranscriptPart[] = current.partial
    ? [...current.finals, current.partial]
    : [...current.finals];
  useDictationStore.setState({ transcript: joinTranscript(parts) });
}

/** Releases everything the session holds. The store is left to the caller. */
function end(current: Session): void {
  current.ended = true;
  current.capture?.stop();
  current.capture = null;
  if (current.limitTimer !== null) clearTimeout(current.limitTimer);
  current.stopWatchingModels?.();
  current.stopWatchingModels = null;
  if (session === current) session = null;
}

function fail(current: Session, reason: DictationErrorReason, message: string): void {
  if (current.ended) return;
  end(current);
  dispatch({ type: "fail", reason, message });
}

/** Sends the next piece of audio to the model: finished utterances first, then the open one. */
function pump(current: Session): void {
  if (current.ended || current.transcribing || !current.modelReady) return;
  const next = current.queued.shift();
  if (next) {
    current.transcribing = true;
    transcribeDictation(next.samples).then(
      (text) => {
        if (current.ended) return;
        current.transcribing = false;
        current.finals.push({ text, continuesPrevious: next.continuesPrevious });
        if (current.partial?.segmentId === next.id) current.partial = null;
        publishTranscript(current);
        pump(current);
      },
      (error: unknown) => modelFailed(current, error),
    );
    return;
  }
  if (current.confirmed) {
    finish(current);
    return;
  }
  const open = current.segmenter.current();
  if (open === null || open.frames - current.partialFrames < PARTIAL_STEP_FRAMES) return;
  const audio = current.segmenter.currentSamples();
  if (audio === null) return;
  current.partialFrames = open.frames;
  current.transcribing = true;
  transcribeDictation(audio.samples).then(
    (text) => {
      if (current.ended) return;
      current.transcribing = false;
      // A partial for an utterance that has since finished still shows until its final lands.
      if (current.partial === null || current.partial.segmentId <= audio.id) {
        current.partial = { segmentId: audio.id, text, continuesPrevious: audio.continuesPrevious };
        publishTranscript(current);
      }
      pump(current);
    },
    (error: unknown) => modelFailed(current, error),
  );
}

function modelFailed(current: Session, error: unknown): void {
  console.warn("Dictation could not transcribe.", error);
  fail(current, "model-failed", "The dictation model stopped working. Try again.");
}

function finish(current: Session): void {
  const text = joinTranscript(current.finals);
  end(current);
  if (text.length === 0) {
    dispatch({ type: "fail", reason: "no-speech", message: "No speech was heard." });
    return;
  }
  current.onCommit(text);
  useDictationStore.setState({ ownerKey: null, transcript: "" });
  dispatch({ type: "done" });
}

function onFrame(current: Session, frame: Float32Array, level: number): void {
  if (current.ended || current.confirmed) return;
  for (const listener of levelListeners) listener(level);
  const finished = current.segmenter.push(frame, level);
  if (finished.length > 0) {
    current.queued.push(...finished);
    current.partialFrames = 0;
  }
  pump(current);
}

/** Resolves once the environment has the model, showing its download meanwhile. */
function ensureModelDownloaded(current: Session, environmentId: EnvironmentId): Promise<boolean> {
  return new Promise((resolve) => {
    let requested = false;
    let settled = false;
    const settle = (ready: boolean) => {
      settled = true;
      current.stopWatchingModels?.();
      current.stopWatchingModels = null;
      resolve(ready);
    };
    const onState = (state: VoiceModelsState | null) => {
      if (current.ended) return settle(false);
      const model = state?.dictation;
      if (!model) {
        fail(current, "unavailable", unavailableMessage());
        return settle(false);
      }
      if (model.phase === "ready") return settle(true);
      if (model.phase === "downloading") {
        dispatch({
          type: "download-progress",
          downloadedBytes: model.downloadedBytes,
          totalBytes: model.totalBytes,
        });
        return;
      }
      if (model.phase === "failed" && requested) {
        fail(current, "download-failed", model.message ?? "The dictation model didn't download.");
        return settle(false);
      }
      // Absent, or failed before this press: ask for it (again).
      requested = true;
      dispatch({ type: "download-progress", downloadedBytes: 0, totalBytes: model.totalBytes });
      void startVoiceModelDownload(environmentId, DICTATION_MODEL_KEY).then((result) => {
        if (result._tag === "Failure" && !current.ended) {
          fail(current, "download-failed", "Couldn't start downloading the dictation model.");
          settle(false);
        }
      });
    };
    const unsubscribe = subscribeVoiceModels(environmentId, onState);
    // The first state arrives during the subscribe call and may already settle it.
    if (settled) unsubscribe();
    else current.stopWatchingModels = unsubscribe;
  });
}

function unavailableMessage(): string {
  return "Dictation needs a ViewCode server that can serve its speech model. Update the server, then try again.";
}

async function prepare(current: Session): Promise<void> {
  const environmentId = readReadAloudEnvironmentId();
  if (environmentId === null) {
    fail(current, "unavailable", "Dictation needs a connected ViewCode server.");
    return;
  }
  const models = await readVoiceModels(environmentId);
  if (current.ended) return;
  if (models?.dictation === undefined) {
    fail(current, "unavailable", unavailableMessage());
    return;
  }
  if (
    models.dictation.phase !== "ready" &&
    !(await ensureModelDownloaded(current, environmentId))
  ) {
    return;
  }
  if (current.ended) return;

  // Signed while the microphone opens; the model loads once capture has started.
  const modelUrl = isDictationModelLoaded()
    ? null
    : createVoiceModelBaseUrl(environmentId, DICTATION_MODEL_KEY);
  // A rejection is reported below; this keeps it handled meanwhile.
  modelUrl?.catch(() => {});

  let capture: DictationCapture;
  try {
    capture = await openDictationCapture({
      onFrame: (frame, level) => onFrame(current, frame, level),
      onEnded: () => fail(current, "microphone-lost", "The microphone was disconnected."),
    });
  } catch (error) {
    const reason = error instanceof DictationCaptureError ? error.reason : "microphone-busy";
    const message = error instanceof Error ? error.message : "Couldn't start the microphone.";
    fail(current, reason, message);
    return;
  }
  if (current.ended) {
    capture.stop();
    return;
  }
  current.capture = capture;
  current.limitTimer = setTimeout(() => confirmDictation(current.ownerKey), DICTATION_LIMIT_MS);
  current.modelReady = isDictationModelLoaded();
  dispatch({ type: "microphone-open", modelReady: current.modelReady });
  if (current.modelReady) return;

  try {
    const url = await (modelUrl ?? createVoiceModelBaseUrl(environmentId, DICTATION_MODEL_KEY));
    await loadDictationModel(url, (loaded) => {
      if (!current.ended) dispatch({ type: "model-progress", loaded });
    });
  } catch (error) {
    console.warn("Dictation could not load its model.", error);
    fail(current, "model-failed", "Couldn't load the dictation model. Try again.");
    return;
  }
  if (current.ended) return;
  current.modelReady = true;
  dispatch({ type: "model-ready" });
  pump(current);
}

/**
 * Starts dictating for `ownerKey`. The transcript goes to `onCommit` when the
 * user confirms; nothing is inserted if they cancel.
 */
export function startDictation(ownerKey: string, onCommit: (text: string) => void): void {
  const store = useDictationStore.getState();
  if (session !== null || (store.state.phase !== "idle" && store.state.phase !== "error")) return;
  const current: Session = {
    ownerKey,
    onCommit,
    segmenter: new DictationSegmenter(),
    queued: [],
    finals: [],
    partial: null,
    partialFrames: 0,
    capture: null,
    modelReady: false,
    transcribing: false,
    confirmed: false,
    ended: false,
    limitTimer: null,
    stopWatchingModels: null,
  };
  session = current;
  useDictationStore.setState({ ownerKey, transcript: "" });
  dispatch({ type: "start" });
  if (!isDictationSupported()) {
    fail(current, "unsupported", "This browser can't dictate.");
    return;
  }
  void prepare(current);
}

/** Stops listening and inserts what was heard once the model has read the last words. */
export function confirmDictation(ownerKey: string): void {
  const current = session;
  if (current === null || current.ownerKey !== ownerKey || current.confirmed) return;
  if (useDictationStore.getState().state.phase !== "listening") return;
  current.confirmed = true;
  if (current.limitTimer !== null) clearTimeout(current.limitTimer);
  current.capture?.stop();
  current.capture = null;
  const last = current.segmenter.flush();
  if (last) current.queued.push(last);
  dispatch({ type: "confirm" });
  pump(current);
}

/** Discards the dictation (or dismisses its error) when `ownerKey` owns it. */
export function cancelDictation(ownerKey: string): void {
  if (useDictationStore.getState().ownerKey !== ownerKey) return;
  if (session !== null) end(session);
  useDictationStore.setState({ ownerKey: null, transcript: "" });
  dispatch({ type: "cancel" });
}

/** The composer's microphone: starts, confirms while listening, or dismisses an error and retries. */
export function toggleDictation(ownerKey: string, onCommit: (text: string) => void): void {
  const { ownerKey: owner, state } = useDictationStore.getState();
  switch (state.phase) {
    case "idle":
    case "error":
      startDictation(ownerKey, onCommit);
      return;
    case "listening":
      confirmDictation(ownerKey);
      return;
    case "preparing":
    case "downloading":
      if (owner === ownerKey) cancelDictation(ownerKey);
      return;
    case "finishing":
      return;
  }
}
