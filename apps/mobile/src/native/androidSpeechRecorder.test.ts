import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

type Listener = (event: unknown) => void;

const mocks = vi.hoisted(() => ({
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  start: vi.fn(),
  stop: vi.fn(),
  abort: vi.fn(),
}));

function emit(name: string, event: unknown = null) {
  for (const listener of [...(mocks.listeners.get(name) ?? [])]) listener(event);
}

vi.mock("react-native", () => ({ Platform: { OS: "android", Version: 34 } }));

vi.mock("expo-speech-recognition", () => ({
  ExpoSpeechRecognitionModule: {
    start: mocks.start,
    stop: mocks.stop,
    abort: mocks.abort,
    isRecognitionAvailable: () => true,
    addListener: (name: string, listener: Listener) => {
      const set = mocks.listeners.get(name) ?? new Set();
      set.add(listener);
      mocks.listeners.set(name, set);
      return { remove: () => set.delete(listener) };
    },
  },
}));

import { AndroidSpeechRecorder, takeAndroidSpeechTranscript } from "./androidSpeechRecorder";
import { getLocalVoiceTranscriber } from "./voiceTranscription.android";

const result = (transcript: string, isFinal: boolean) => ({
  isFinal,
  results: [{ transcript, confidence: 1, segments: [] }],
});

async function startRecording(onStatus = vi.fn()) {
  const recorder = new AndroidSpeechRecorder(onStatus);
  await recorder.prepareToRecordAsync();
  recorder.record({ forDuration: 120 });
  return { recorder, onStatus, uri: recorder.uri ?? "" };
}

beforeEach(() => {
  mocks.listeners.clear();
  vi.resetAllMocks();
});

describe("AndroidSpeechRecorder", () => {
  it("joins final phrases and the trailing partial once the user stops", async () => {
    const { recorder, onStatus, uri } = await startRecording();
    emit("result", result("Fix the build", true));
    emit("result", result("and push", false));
    const stopped = recorder.stop();
    expect(mocks.stop).toHaveBeenCalledOnce();
    emit("end");
    await stopped;

    expect(takeAndroidSpeechTranscript(uri)).toBe("Fix the build and push");
    // A stop the controller asked for is not reported back as a finished recording.
    expect(onStatus).not.toHaveBeenCalled();
  });

  it("finishes the recording itself when recognition ends on its own", async () => {
    const { onStatus, uri } = await startRecording();
    emit("result", result("Hello", true));
    emit("end");

    expect(onStatus).toHaveBeenCalledWith({
      isFinished: true,
      hasError: false,
      error: null,
      url: uri,
    });
  });

  it("treats silence as an empty transcript and real failures as errors", async () => {
    const silent = await startRecording();
    emit("error", { error: "no-speech", message: "" });
    emit("end");
    expect(takeAndroidSpeechTranscript(silent.uri)).toBe("");

    const failing = await startRecording();
    emit("error", { error: "not-allowed", message: "denied" });
    expect(failing.onStatus).toHaveBeenCalledWith({
      isFinished: false,
      hasError: true,
      error: "Microphone access is off for ViewCode.",
      url: failing.uri,
    });
  });
});

describe("getLocalVoiceTranscriber on Android", () => {
  it("hands over the recorder's transcript once", async () => {
    const { recorder, uri } = await startRecording();
    emit("result", result("Ship it", true));
    const stopped = recorder.stop();
    emit("end");
    await stopped;

    const signal = new AbortController().signal;
    const prepared = await getLocalVoiceTranscriber()?.prepare({ signal });
    await expect(prepared?.transcribe(uri, { signal })).resolves.toBe("Ship it");
    await expect(prepared?.transcribe(uri, { signal })).rejects.toThrow(
      "Speech recognition did not return a transcript.",
    );
  });
});
