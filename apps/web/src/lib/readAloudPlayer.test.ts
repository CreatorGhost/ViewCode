import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { speakReadAloud, stopReadAloud, useReadAloudStore } from "./readAloudPlayer";

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

const SETTINGS = { readAloudVoice: null, readAloudRate: 1.5 };
let synth: ReturnType<typeof fakeSpeechSynthesis>;

beforeEach(() => {
  synth = fakeSpeechSynthesis();
  vi.stubGlobal("speechSynthesis", synth);
  vi.stubGlobal("SpeechSynthesisUtterance", FakeUtterance);
});

afterEach(() => {
  stopReadAloud();
  vi.unstubAllGlobals();
});

describe("read aloud player", () => {
  it("queues the reply's chunks with the chosen voice and clears when the last one ends", () => {
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
  });

  it("replaces whatever is playing and ignores the cancelled reply's events", () => {
    speakReadAloud("thread:a1", "One.", SETTINGS);
    speakReadAloud("thread:a2", "Two.", SETTINGS);

    expect(synth.cancel).toHaveBeenCalled();
    expect(useReadAloudStore.getState().playingKey).toBe("thread:a2");
    expect(synth.queue.map((utterance) => utterance.text)).toEqual(["Two."]);
  });

  it("stops on demand and on a speech error", () => {
    speakReadAloud("thread:a1", "One.", SETTINGS);
    stopReadAloud();
    expect(useReadAloudStore.getState().playingKey).toBeNull();
    expect(synth.queue).toEqual([]);

    speakReadAloud("thread:a1", "One.", SETTINGS);
    synth.queue[0]!.dispatchEvent(new Event("error"));
    expect(useReadAloudStore.getState().playingKey).toBeNull();
  });

  it("does nothing without speechSynthesis", () => {
    vi.stubGlobal("speechSynthesis", undefined);
    speakReadAloud("thread:a1", "One.", SETTINGS);
    expect(useReadAloudStore.getState().playingKey).toBeNull();
  });
});
