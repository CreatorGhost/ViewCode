import { describe, expect, it } from "vite-plus/test";

import {
  DICTATION_IDLE,
  type DictationEvent,
  DictationSegmenter,
  type DictationState,
  dictationInsertion,
  dictationReducer,
  joinTranscript,
} from "./dictation.logic";
import { DICTATION_FRAME_SAMPLES } from "./dictationAudio";

const run = (events: ReadonlyArray<DictationEvent>, from: DictationState = DICTATION_IDLE) =>
  events.reduce(dictationReducer, from);

describe("dictationReducer", () => {
  it("goes from the microphone to listening to finishing to idle", () => {
    const listening = run([{ type: "start" }, { type: "microphone-open", modelReady: true }]);
    expect(listening).toEqual({ phase: "listening", model: "ready", loaded: null });
    const finishing = dictationReducer(listening, { type: "confirm" });
    expect(finishing).toEqual({ phase: "finishing" });
    expect(dictationReducer(finishing, { type: "done" })).toEqual(DICTATION_IDLE);
  });

  it("shows the first download, then listens while the model loads", () => {
    const downloading = run([
      { type: "start" },
      { type: "download-progress", downloadedBytes: 10, totalBytes: 100 },
    ]);
    expect(downloading).toEqual({ phase: "downloading", downloadedBytes: 10, totalBytes: 100 });
    const loading = run(
      [
        { type: "microphone-open", modelReady: false },
        { type: "model-progress", loaded: 0.5 },
        // Progress never runs backwards when a later file starts.
        { type: "model-progress", loaded: 0.2 },
      ],
      downloading,
    );
    expect(loading).toEqual({ phase: "listening", model: "loading", loaded: 0.5 });
    expect(dictationReducer(loading, { type: "model-ready" })).toEqual({
      phase: "listening",
      model: "ready",
      loaded: null,
    });
  });

  it("confirms only while listening", () => {
    expect(run([{ type: "start" }, { type: "confirm" }])).toEqual({ phase: "preparing" });
  });

  it("cancels from any phase, and a later failure stays hidden", () => {
    const cancelled = run([
      { type: "start" },
      { type: "microphone-open", modelReady: true },
      { type: "cancel" },
      { type: "fail", reason: "model-failed", message: "late" },
    ]);
    expect(cancelled).toEqual(DICTATION_IDLE);
  });

  it("reports a failure, and starting again retries", () => {
    const failed = run([
      { type: "start" },
      { type: "fail", reason: "permission-denied", message: "Blocked" },
    ]);
    expect(failed).toEqual({ phase: "error", reason: "permission-denied", message: "Blocked" });
    // The first failure is what the user sees, not a cascade after it.
    expect(dictationReducer(failed, { type: "fail", reason: "no-speech", message: "x" })).toBe(
      failed,
    );
    expect(dictationReducer(failed, { type: "start" })).toEqual({ phase: "preparing" });
  });

  it("ignores a second start while one is running", () => {
    const listening = run([{ type: "start" }, { type: "microphone-open", modelReady: true }]);
    expect(dictationReducer(listening, { type: "start" })).toBe(listening);
  });
});

const QUIET = 0.001;
const LOUD = 0.1;
const frame = (marker = 0) => new Float32Array(DICTATION_FRAME_SAMPLES).fill(marker);

/** Pushes `count` frames at `level`, collecting the utterances they finish. */
function feed(
  segmenter: DictationSegmenter,
  level: number,
  count: number,
  marker = level === LOUD ? 1 : 0,
) {
  const finished = [];
  for (let index = 0; index < count; index += 1) {
    finished.push(...segmenter.push(frame(marker), level));
  }
  return finished;
}

describe("DictationSegmenter", () => {
  it("finishes an utterance after a pause, keeping a little audio either side", () => {
    const segmenter = new DictationSegmenter();
    expect(feed(segmenter, QUIET, 20)).toEqual([]);
    expect(feed(segmenter, LOUD, 20)).toEqual([]);
    expect(segmenter.current()).toMatchObject({ id: 1 });
    // 0.7 s of quiet ends it.
    const finished = feed(segmenter, QUIET, 14);
    expect(finished).toHaveLength(1);
    const [segment] = finished;
    // 0.3 s pre-roll, 1 s of speech, 0.2 s tail.
    expect(segment!.samples.length).toBe((6 + 20 + 4) * DICTATION_FRAME_SAMPLES);
    expect(segment!.continuesPrevious).toBe(false);
    expect(segmenter.current()).toBeNull();
  });

  it("drops a click too short to be speech", () => {
    const segmenter = new DictationSegmenter();
    feed(segmenter, QUIET, 10);
    feed(segmenter, LOUD, 1);
    expect(segmenter.current()).toBeNull();
    expect(feed(segmenter, QUIET, 20)).toEqual([]);
  });

  it("splits a long monologue at its quietest recent moment and marks the continuation", () => {
    const segmenter = new DictationSegmenter({ maxSegmentFrames: 40, splitSearchFrames: 20 });
    feed(segmenter, LOUD, 30);
    // A breath between words, too short to end the utterance.
    feed(segmenter, 0.02, 1, 7);
    const finished = feed(segmenter, LOUD, 9);
    expect(finished).toHaveLength(1);
    const first = finished[0]!;
    // Cut right after the breath frame.
    expect(first.samples.length).toBe(31 * DICTATION_FRAME_SAMPLES);
    expect(first.samples[first.samples.length - 1]).toBe(7);
    const rest = segmenter.flush();
    expect(rest).toMatchObject({ continuesPrevious: true });
    expect(rest!.samples.length).toBe(9 * DICTATION_FRAME_SAMPLES);
  });

  it("flushes the open utterance when dictation ends mid-word", () => {
    const segmenter = new DictationSegmenter();
    feed(segmenter, LOUD, 10);
    expect(segmenter.currentSamples()?.samples.length).toBe(10 * DICTATION_FRAME_SAMPLES);
    expect(segmenter.flush()?.samples.length).toBe(10 * DICTATION_FRAME_SAMPLES);
    expect(segmenter.flush()).toBeNull();
  });

  it("follows a noisy room's floor so steady noise is not speech", () => {
    const segmenter = new DictationSegmenter();
    // Below the threshold at first, the hum raises the floor over a few seconds.
    feed(segmenter, 0.006, 100);
    expect(segmenter.isSpeech(0.015)).toBe(false);
    expect(segmenter.isSpeech(LOUD)).toBe(true);
  });
});

describe("joinTranscript", () => {
  it("joins utterances with single spaces and skips empty ones", () => {
    expect(
      joinTranscript([
        { text: " Open the  settings. ", continuesPrevious: false },
        { text: "", continuesPrevious: false },
        { text: "Then restart.", continuesPrevious: false },
      ]),
    ).toBe("Open the settings. Then restart.");
  });

  it("rejoins a sentence that was split mid-utterance", () => {
    expect(
      joinTranscript([
        { text: "Refactor the session store so that.", continuesPrevious: false },
        { text: "The worker owns the model.", continuesPrevious: true },
      ]),
    ).toBe("Refactor the session store so that the worker owns the model.");
  });

  it("keeps capitals that are not just sentence starts", () => {
    expect(
      joinTranscript([
        { text: "Then", continuesPrevious: false },
        { text: "I think API keys belong there.", continuesPrevious: true },
      ]),
    ).toBe("Then I think API keys belong there.");
    expect(
      joinTranscript([
        { text: "Ship it", continuesPrevious: false },
        { text: "HTTP first.", continuesPrevious: true },
      ]),
    ).toBe("Ship it HTTP first.");
  });

  it("leaves a real sentence end alone", () => {
    expect(
      joinTranscript([
        { text: "Is it done?", continuesPrevious: false },
        { text: "Yes.", continuesPrevious: true },
      ]),
    ).toBe("Is it done? Yes.");
  });
});

describe("dictationInsertion", () => {
  it("adds spaces only where the text would run into a word", () => {
    expect(dictationInsertion("", 0, " hello ")).toBe("hello");
    expect(dictationInsertion("Fix this", 8, "now")).toBe(" now");
    expect(dictationInsertion("Fix  bug", 4, "the")).toBe("the");
    expect(dictationInsertion("Fixbug", 3, "the")).toBe(" the ");
    expect(dictationInsertion("Fix .", 4, "it")).toBe("it");
    expect(dictationInsertion("anything", 0, "")).toBe("");
  });
});
