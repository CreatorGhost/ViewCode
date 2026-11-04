import type { VoiceModelDownloadState, VoiceModelsState } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { DictationState } from "./dictation.logic";
import { DICTATION_FRAME_SAMPLES } from "./dictationAudio";
import {
  cancelDictation,
  confirmDictation,
  startDictation,
  useDictationStore,
} from "./dictationSession";

const host = vi.hoisted(() => ({
  models: null as VoiceModelsState | null,
  modelListener: null as ((state: VoiceModelsState | null) => void) | null,
  startVoiceModelDownload: vi.fn(async () => ({ _tag: "Success" as const })),
  modelLoaded: false,
  transcriptions: [] as number[],
  onFrame: null as ((frame: Float32Array, level: number) => void) | null,
  openCapture: vi.fn(),
  stopCapture: vi.fn(),
}));

vi.mock("../state/voiceModels", () => ({
  readReadAloudEnvironmentId: () => "environment-1",
  readVoiceModels: async () => host.models,
  subscribeVoiceModels: (_: unknown, listener: (state: VoiceModelsState | null) => void) => {
    host.modelListener = listener;
    listener(host.models);
    return () => {
      host.modelListener = null;
    };
  },
  startVoiceModelDownload: host.startVoiceModelDownload,
  createVoiceModelBaseUrl: async () => "https://environment.test/api/assets/token",
}));

vi.mock("./dictationCapture", async (original) => ({
  ...(await original<typeof import("./dictationCapture")>()),
  isDictationSupported: () => true,
  openDictationCapture: host.openCapture,
}));

vi.mock("./dictationModel", () => ({
  isDictationModelLoaded: () => host.modelLoaded,
  loadDictationModel: async () => {
    host.modelLoaded = true;
  },
  // Each transcript is the clip's length in 50 ms frames, so tests can tell clips apart.
  transcribeDictation: async (samples: Float32Array) => {
    const frames = Math.round(samples.length / DICTATION_FRAME_SAMPLES);
    host.transcriptions.push(frames);
    return `${frames}f`;
  },
}));

const withDictation = (dictation: VoiceModelDownloadState): VoiceModelsState => ({
  tiers: [],
  dictation,
});
const READY = withDictation({
  phase: "ready",
  downloadedBytes: 10,
  totalBytes: 10,
  message: null,
});

/** Resolves once the store reaches a state matching `predicate`. */
function until(predicate: (state: DictationState) => boolean): Promise<DictationState> {
  return new Promise((resolve) => {
    const check = () => {
      const { state } = useDictationStore.getState();
      if (!predicate(state)) return false;
      unsubscribe();
      resolve(state);
      return true;
    };
    const unsubscribe = useDictationStore.subscribe(() => void check());
    check();
  });
}

function speak(frames: number, level: number) {
  for (let index = 0; index < frames; index += 1) {
    host.onFrame!(new Float32Array(DICTATION_FRAME_SAMPLES), level);
  }
}

const OWNER = "thread-1";

beforeEach(() => {
  host.models = READY;
  host.modelListener = null;
  host.modelLoaded = false;
  host.transcriptions = [];
  host.onFrame = null;
  host.startVoiceModelDownload.mockClear();
  host.stopCapture.mockClear();
  host.openCapture.mockReset();
  host.openCapture.mockImplementation(
    async (options: { onFrame: (frame: Float32Array, level: number) => void }) => {
      host.onFrame = options.onFrame;
      return { stop: host.stopCapture };
    },
  );
});

afterEach(() => {
  cancelDictation(useDictationStore.getState().ownerKey ?? OWNER);
});

describe("dictation session", () => {
  it("transcribes while listening and inserts every utterance in order on confirm", async () => {
    const commit = vi.fn();
    startDictation(OWNER, commit);
    await until((state) => state.phase === "listening" && state.model === "ready");

    // An utterance, a pause that ends it, then words still being spoken at confirm.
    speak(20, 0.1);
    speak(14, 0.001);
    speak(10, 0.1);
    confirmDictation(OWNER);
    expect(host.stopCapture).toHaveBeenCalled();
    await until((state) => state.phase === "idle");

    // A partial pass at 12 frames, the finished utterance (with its tail), and the flushed one.
    expect(host.transcriptions).toEqual([12, 24, 10]);
    expect(commit).toHaveBeenCalledExactlyOnceWith("24f 10f");
    expect(useDictationStore.getState()).toMatchObject({ ownerKey: null, transcript: "" });
  });

  it("downloads the model on first use, showing its progress, then listens", async () => {
    host.models = withDictation({
      phase: "absent",
      downloadedBytes: 0,
      totalBytes: null,
      message: null,
    });
    startDictation(OWNER, vi.fn());
    await until((state) => state.phase === "downloading");
    expect(host.startVoiceModelDownload).toHaveBeenCalledWith("environment-1", "dictation");
    host.modelListener!(
      withDictation({ phase: "downloading", downloadedBytes: 5, totalBytes: 10, message: null }),
    );
    expect(useDictationStore.getState().state).toEqual({
      phase: "downloading",
      downloadedBytes: 5,
      totalBytes: 10,
    });
    host.modelListener!(READY);
    await until((state) => state.phase === "listening");
    expect(host.openCapture).toHaveBeenCalledOnce();
  });

  it("explains a download that fails", async () => {
    host.models = withDictation({
      phase: "absent",
      downloadedBytes: 0,
      totalBytes: null,
      message: null,
    });
    startDictation(OWNER, vi.fn());
    await until((state) => state.phase === "downloading");
    host.modelListener!(
      withDictation({ phase: "failed", downloadedBytes: 0, totalBytes: 10, message: "Offline." }),
    );
    expect(await until((state) => state.phase === "error")).toEqual({
      phase: "error",
      reason: "download-failed",
      message: "Offline.",
    });
    expect(host.openCapture).not.toHaveBeenCalled();
  });

  it("says when the server cannot serve the model", async () => {
    host.models = { tiers: [] };
    startDictation(OWNER, vi.fn());
    expect(await until((state) => state.phase === "error")).toMatchObject({
      reason: "unavailable",
    });
  });

  it("reports a blocked microphone", async () => {
    const { DictationCaptureError } = await import("./dictationCapture");
    host.openCapture.mockRejectedValue(new DictationCaptureError("permission-denied", "Blocked."));
    startDictation(OWNER, vi.fn());
    expect(await until((state) => state.phase === "error")).toEqual({
      phase: "error",
      reason: "permission-denied",
      message: "Blocked.",
    });
  });

  it("says so when nothing was heard, and inserts nothing", async () => {
    const commit = vi.fn();
    startDictation(OWNER, commit);
    await until((state) => state.phase === "listening" && state.model === "ready");
    speak(30, 0.001);
    confirmDictation(OWNER);
    expect(await until((state) => state.phase === "error")).toMatchObject({ reason: "no-speech" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("discards on cancel and releases the microphone", async () => {
    const commit = vi.fn();
    startDictation(OWNER, commit);
    await until((state) => state.phase === "listening" && state.model === "ready");
    speak(20, 0.1);
    cancelDictation(OWNER);
    expect(host.stopCapture).toHaveBeenCalled();
    expect(useDictationStore.getState()).toMatchObject({
      ownerKey: null,
      state: { phase: "idle" },
      transcript: "",
    });
    // Another composer can't cancel or confirm a dictation it doesn't own.
    startDictation(OWNER, commit);
    await until((state) => state.phase === "listening");
    cancelDictation("thread-2");
    confirmDictation("thread-2");
    expect(useDictationStore.getState().state.phase).toBe("listening");
    expect(commit).not.toHaveBeenCalled();
  });
});
