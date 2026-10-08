import type { VoiceModelsState } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { speakReadAloud, stopReadAloud, useReadAloudStore } from "./readAloudPlayer";

const host = vi.hoisted(() => ({
  models: null as VoiceModelsState | null,
  readVoiceModels: vi.fn(),
  startVoiceModelDownload: vi.fn(),
  synthesizeKokoro: vi.fn(),
}));

vi.mock("../state/voiceModels", () => ({
  readReadAloudEnvironmentId: () => "environment-1",
  readVoiceModels: host.readVoiceModels,
  startVoiceModelDownload: host.startVoiceModelDownload,
  createVoiceModelBaseUrl: async () => "https://environment.test/api/assets/token",
}));

vi.mock("./readAloudKokoro", () => ({
  isKokoroSupported: () => true,
  synthesizeKokoro: host.synthesizeKokoro,
  closeKokoro: () => {},
}));

class FakeUtterance extends EventTarget {
  voice: unknown = null;
  lang = "";
  rate = 1;
  constructor(readonly text: string) {
    super();
  }
}

function fakeSpeechSynthesis() {
  const queue: FakeUtterance[] = [];
  return {
    queue,
    speak: vi.fn((utterance: FakeUtterance) => queue.push(utterance)),
    cancel: vi.fn(() => {
      // Like Chromium, cancelling reports an error on everything still queued.
      for (const utterance of queue.splice(0)) utterance.dispatchEvent(new Event("error"));
    }),
    getVoices: () => [{ voiceURI: "samantha", lang: "en-US" }],
    finishAll() {
      for (const utterance of queue.splice(0)) utterance.dispatchEvent(new Event("end"));
    },
  };
}

/** Web Audio that records each clip it starts; a clip ends when the test says so. */
class FakeAudioContext {
  static started: Array<{ samples: Float32Array; end: () => void }> = [];
  resume = async () => {};
  suspend = async () => {};
  destination = {};
  createBuffer(_channels: number, length: number) {
    const samples = new Float32Array(length);
    return { samples, copyToChannel: (source: Float32Array) => samples.set(source) };
  }
  createBufferSource() {
    const source = Object.assign(new EventTarget(), {
      buffer: null as { samples: Float32Array } | null,
      connect: () => {},
      disconnect: () => {},
      start: () =>
        FakeAudioContext.started.push({
          samples: source.buffer!.samples,
          end: () => source.dispatchEvent(new Event("ended")),
        }),
      stop: () => source.dispatchEvent(new Event("ended")),
    });
    return source;
  }
}

const modelsWithSmall = (phase: "absent" | "downloading" | "ready" | "failed") => ({
  tiers: [{ tier: "small", phase, downloadedBytes: 0, totalBytes: 10, message: null }] as const,
});
const SYSTEM = {
  readAloudVoice: { engine: "system", voiceURI: null },
  readAloudRate: 1.5,
} as const;
const NATURAL = { readAloudVoice: null, readAloudRate: 1.25 };
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const clipFor = (text: string) => ({
  samples: new Float32Array([text.length]),
  sampleRate: 24_000,
});
let synth: ReturnType<typeof fakeSpeechSynthesis>;

beforeEach(() => {
  synth = fakeSpeechSynthesis();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  FakeAudioContext.started = [];
  host.readVoiceModels.mockImplementation(async () => host.models);
  host.synthesizeKokoro.mockImplementation(async (_source: unknown, text: string) => clipFor(text));
});

afterEach(() => {
  stopReadAloud();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("read aloud player", () => {
  it("queues the reply's chunks with the chosen system voice and clears when the last one ends", () => {
    speakReadAloud("thread:a1", "First paragraph.\n\nSecond paragraph.", {
      readAloudVoice: { engine: "system", voiceURI: "samantha" },
      readAloudRate: 1.25,
    });

    expect(useReadAloudStore.getState().playingKey).toBe("thread:a1");
    expect(synth.queue.map((utterance) => utterance.text)).toEqual([
      "First paragraph. Second paragraph.",
    ]);
    expect(synth.queue[0]).toMatchObject({ rate: 1.25, lang: "en-US" });

    synth.finishAll();
    expect(useReadAloudStore.getState().playingKey).toBeNull();
    expect(host.readVoiceModels).not.toHaveBeenCalled();
  });

  it("replaces whatever is playing and ignores the cancelled reply's events", () => {
    speakReadAloud("thread:a1", "One.", SYSTEM);
    speakReadAloud("thread:a2", "Two.", SYSTEM);

    expect(synth.cancel).toHaveBeenCalled();
    expect(useReadAloudStore.getState().playingKey).toBe("thread:a2");
    expect(synth.queue.map((utterance) => utterance.text)).toEqual(["Two."]);
  });

  it("stops on demand and on a speech error", () => {
    speakReadAloud("thread:a1", "One.", SYSTEM);
    stopReadAloud();
    expect(useReadAloudStore.getState().playingKey).toBeNull();
    expect(synth.queue).toEqual([]);

    speakReadAloud("thread:a1", "One.", SYSTEM);
    synth.queue[0]!.dispatchEvent(new Event("error"));
    expect(useReadAloudStore.getState().playingKey).toBeNull();
  });

  it("does nothing for a system voice without speechSynthesis", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    speakReadAloud("thread:a1", "One.", SYSTEM);
    expect(useReadAloudStore.getState().playingKey).toBeNull();
  });

  it("reads with the system voice while the natural voice downloads, and starts it once", async () => {
    host.models = modelsWithSmall("absent");
    speakReadAloud("thread:a1", "One.", NATURAL);
    await settle();

    expect(host.startVoiceModelDownload).toHaveBeenCalledWith("environment-1", "small");
    expect(synth.queue.map((utterance) => utterance.text)).toEqual(["One."]);
    expect(useReadAloudStore.getState().notice).toEqual({
      key: "thread:a1",
      reason: "downloading",
      tier: "small",
    });
    synth.finishAll();
    // The notice stays so the download's progress stays beside the button.
    expect(useReadAloudStore.getState()).toMatchObject({
      playingKey: null,
      notice: { key: "thread:a1" },
    });

    host.models = modelsWithSmall("downloading");
    speakReadAloud("thread:a2", "Two.", NATURAL);
    await settle();
    expect(host.startVoiceModelDownload).toHaveBeenCalledTimes(1);
    expect(useReadAloudStore.getState().notice?.key).toBe("thread:a2");
  });

  it("does not retry a failed download on every press", async () => {
    host.models = modelsWithSmall("failed");
    speakReadAloud("thread:a1", "One.", NATURAL);
    await settle();
    expect(host.startVoiceModelDownload).not.toHaveBeenCalled();
    expect(useReadAloudStore.getState().notice?.reason).toBe("failed");
    expect(synth.queue).toHaveLength(1);
  });

  it("plays the natural voice chunk by chunk at the chosen speed", async () => {
    host.models = modelsWithSmall("ready");
    const long = Array.from({ length: 12 }, (_, index) => `Sentence number ${index} is here.`);
    speakReadAloud("thread:a1", long.join(" "), NATURAL);
    await settle();

    expect(synth.queue).toEqual([]);
    expect(host.synthesizeKokoro).toHaveBeenCalledWith(
      { tier: "small", modelBaseUrl: "https://environment.test/api/assets/token" },
      expect.any(String),
      "af_heart",
      1.25,
    );
    expect(FakeAudioContext.started).toHaveLength(1);
    FakeAudioContext.started[0]!.end();
    await settle();
    expect(FakeAudioContext.started).toHaveLength(2);
    FakeAudioContext.started[1]!.end();
    await settle();
    expect(useReadAloudStore.getState().playingKey).toBeNull();
  });

  it("stops natural playback and drops the synthesis in flight", async () => {
    host.models = modelsWithSmall("ready");
    const long = Array.from({ length: 12 }, (_, index) => `Sentence number ${index} is here.`);
    speakReadAloud("thread:a1", long.join(" "), NATURAL);
    await settle();
    expect(FakeAudioContext.started).toHaveLength(1);

    stopReadAloud();
    await settle();
    expect(useReadAloudStore.getState().playingKey).toBeNull();
    expect(FakeAudioContext.started).toHaveLength(1);
    expect(synth.queue).toEqual([]);
  });

  it("hands the rest of the reply to the system voice when the natural voice fails", async () => {
    host.models = modelsWithSmall("ready");
    host.synthesizeKokoro
      .mockImplementationOnce(async (_source: unknown, text: string) => clipFor(text))
      .mockImplementationOnce(async () => {
        throw new Error("model crashed");
      });
    const long = Array.from({ length: 12 }, (_, index) => `Sentence number ${index} is here.`);
    speakReadAloud("thread:a1", long.join(" "), NATURAL);
    await settle();
    FakeAudioContext.started[0]!.end();
    await settle();

    expect(synth.queue.map((utterance) => utterance.text).join(" ")).not.toContain("number 0 ");
    expect(synth.queue.map((utterance) => utterance.text).join(" ")).toContain("number 11");
    expect(useReadAloudStore.getState().notice?.reason).toBe("error");
  });
});
