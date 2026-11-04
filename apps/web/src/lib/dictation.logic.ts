// Dictation's pure parts: the state machine the composer renders, the
// segmenter that cuts live audio into utterances for incremental
// transcription, and the rules that join their transcripts.

import { DICTATION_FRAME_MS } from "./dictationAudio";

export type DictationErrorReason =
  | "unsupported"
  | "unavailable"
  | "download-failed"
  | "permission-denied"
  | "no-microphone"
  | "microphone-busy"
  | "microphone-lost"
  | "model-failed"
  | "no-speech";

export type DictationState =
  | { readonly phase: "idle" }
  /** Checking the environment's model and opening the microphone. */
  | { readonly phase: "preparing" }
  /** The environment is downloading the model, which happens once. */
  | {
      readonly phase: "downloading";
      readonly downloadedBytes: number;
      readonly totalBytes: number | null;
    }
  /** Capturing. Audio heard while the model loads is transcribed once it is ready. */
  | {
      readonly phase: "listening";
      readonly model: "loading" | "ready";
      /** How much of the model this client has fetched, 0 to 1, while it loads. */
      readonly loaded: number | null;
    }
  /** Confirmed: the microphone is off and the last words are being transcribed. */
  | { readonly phase: "finishing" }
  | { readonly phase: "error"; readonly reason: DictationErrorReason; readonly message: string };

export type DictationEvent =
  | { readonly type: "start" }
  | {
      readonly type: "download-progress";
      readonly downloadedBytes: number;
      readonly totalBytes: number | null;
    }
  | { readonly type: "microphone-open"; readonly modelReady: boolean }
  | { readonly type: "model-progress"; readonly loaded: number }
  | { readonly type: "model-ready" }
  | { readonly type: "confirm" }
  | { readonly type: "done" }
  | { readonly type: "cancel" }
  | {
      readonly type: "fail";
      readonly reason: DictationErrorReason;
      readonly message: string;
    };

export const DICTATION_IDLE: DictationState = { phase: "idle" };

export function dictationReducer(state: DictationState, event: DictationEvent): DictationState {
  switch (event.type) {
    case "start":
      return state.phase === "idle" || state.phase === "error" ? { phase: "preparing" } : state;
    case "download-progress":
      return state.phase === "preparing" || state.phase === "downloading"
        ? {
            phase: "downloading",
            downloadedBytes: event.downloadedBytes,
            totalBytes: event.totalBytes,
          }
        : state;
    case "microphone-open":
      return state.phase === "preparing" || state.phase === "downloading"
        ? {
            phase: "listening",
            model: event.modelReady ? "ready" : "loading",
            loaded: event.modelReady ? null : 0,
          }
        : state;
    case "model-progress":
      return state.phase === "listening" && state.model === "loading"
        ? { ...state, loaded: Math.max(state.loaded ?? 0, Math.min(1, event.loaded)) }
        : state;
    case "model-ready":
      return state.phase === "listening"
        ? { phase: "listening", model: "ready", loaded: null }
        : state;
    case "confirm":
      return state.phase === "listening" ? { phase: "finishing" } : state;
    case "done":
      return state.phase === "finishing" ? DICTATION_IDLE : state;
    case "cancel":
      return DICTATION_IDLE;
    case "fail":
      // A failure that lands after a cancel belongs to a session nobody is looking at.
      return state.phase === "idle" || state.phase === "error"
        ? state
        : { phase: "error", reason: event.reason, message: event.message };
  }
}

/** The dictation row replaces the composer's controls in every phase but idle. */
export function dictationIsActive(state: DictationState): boolean {
  return state.phase !== "idle";
}

export interface DictationSegmenterOptions {
  /** Frames kept from before speech starts, so a word's onset is not clipped. */
  readonly preRollFrames: number;
  /** Quiet frames that end an utterance. */
  readonly endSilenceFrames: number;
  /** Quiet frames kept after the last speech frame of an utterance. */
  readonly tailFrames: number;
  /** An utterance this long is split at its quietest recent frame. */
  readonly maxSegmentFrames: number;
  /** How far back from the end a split looks for that quiet frame. */
  readonly splitSearchFrames: number;
  /** Utterances with fewer speech frames are noise (a click, a cough) and are dropped. */
  readonly minSpeechFrames: number;
  /** The floor below which nothing counts as speech, however quiet the room. */
  readonly minSpeechLevel: number;
}

const msToFrames = (ms: number) => Math.round(ms / DICTATION_FRAME_MS);

const DEFAULT_DICTATION_SEGMENTER_OPTIONS: DictationSegmenterOptions = {
  preRollFrames: msToFrames(300),
  endSilenceFrames: msToFrames(700),
  tailFrames: msToFrames(200),
  // Moonshine's cost grows with the clip, and each partial pass re-reads the whole
  // utterance, so long monologues are cut into pieces of at most 12 s.
  maxSegmentFrames: msToFrames(12_000),
  splitSearchFrames: msToFrames(3_000),
  minSpeechFrames: msToFrames(150),
  minSpeechLevel: 0.008,
};

export interface DictationSegment {
  readonly id: number;
  readonly samples: Float32Array;
  /** True when the previous segment was cut mid-utterance and this one carries on from it. */
  readonly continuesPrevious: boolean;
}

interface OpenSegment {
  readonly id: number;
  readonly frames: Float32Array[];
  readonly levels: number[];
  readonly continuesPrevious: boolean;
  speechFrames: number;
  /** Frames since the last speech frame. */
  quietFrames: number;
}

function concatFrames(frames: ReadonlyArray<Float32Array>): Float32Array {
  const length = frames.reduce((sum, frame) => sum + frame.length, 0);
  const samples = new Float32Array(length);
  let offset = 0;
  for (const frame of frames) {
    samples.set(frame, offset);
    offset += frame.length;
  }
  return samples;
}

/**
 * Cuts a stream of 50 ms frames into utterances with a voice-activity check
 * whose threshold follows the room's noise floor. Finished utterances go to the
 * speech model once; the open one is re-read as it grows so words appear while
 * the user speaks.
 */
export class DictationSegmenter {
  private readonly options: DictationSegmenterOptions;
  private readonly preRoll: Array<{ frame: Float32Array; level: number }> = [];
  private open: OpenSegment | null = null;
  private nextId = 1;
  private noiseFloor: number;

  constructor(options: Partial<DictationSegmenterOptions> = {}) {
    this.options = { ...DEFAULT_DICTATION_SEGMENTER_OPTIONS, ...options };
    this.noiseFloor = this.options.minSpeechLevel / 3;
  }

  /** Whether a frame at this level counts as speech right now. */
  isSpeech(level: number): boolean {
    return level >= Math.max(this.options.minSpeechLevel, this.noiseFloor * 3);
  }

  /** Feeds one frame; returns the utterances it finished, oldest first. */
  push(frame: Float32Array, level: number): DictationSegment[] {
    const speech = this.isSpeech(level);
    if (!speech) {
      // The floor drops quickly into a quiet room and rises slowly with steady noise.
      const rate = level < this.noiseFloor ? 0.5 : 0.05;
      this.noiseFloor += (level - this.noiseFloor) * rate;
    }
    const finished: DictationSegment[] = [];
    const open = this.open;
    if (open === null) {
      if (!speech) {
        this.preRoll.push({ frame, level });
        if (this.preRoll.length > this.options.preRollFrames) this.preRoll.shift();
        return finished;
      }
      this.open = {
        id: this.nextId++,
        frames: [...this.preRoll.map((each) => each.frame), frame],
        levels: [...this.preRoll.map((each) => each.level), level],
        continuesPrevious: false,
        speechFrames: 1,
        quietFrames: 0,
      };
      this.preRoll.length = 0;
      return finished;
    }

    open.frames.push(frame);
    open.levels.push(level);
    if (speech) {
      open.speechFrames += 1;
      open.quietFrames = 0;
    } else {
      open.quietFrames += 1;
    }

    if (open.quietFrames >= this.options.endSilenceFrames) {
      const keep = open.frames.length - open.quietFrames + this.options.tailFrames;
      const segment = this.close(open, keep, false);
      if (segment) finished.push(segment);
      return finished;
    }
    if (open.frames.length >= this.options.maxSegmentFrames) {
      const searchStart = Math.max(1, open.frames.length - this.options.splitSearchFrames);
      let cut = open.frames.length - 1;
      for (let index = searchStart; index < open.frames.length; index += 1) {
        if ((open.levels[index] ?? 0) < (open.levels[cut] ?? 0)) cut = index;
      }
      const segment = this.close(open, cut + 1, true);
      if (segment) finished.push(segment);
    }
    return finished;
  }

  /** The utterance still being spoken, once it holds enough speech to transcribe. */
  current(): { readonly id: number; readonly frames: number } | null {
    const open = this.open;
    if (open === null || open.speechFrames < this.options.minSpeechFrames) return null;
    return { id: open.id, frames: open.frames.length };
  }

  /** The open utterance's audio so far, for a partial transcription. */
  currentSamples(): DictationSegment | null {
    const open = this.open;
    if (open === null || open.speechFrames < this.options.minSpeechFrames) return null;
    return {
      id: open.id,
      samples: concatFrames(open.frames),
      continuesPrevious: open.continuesPrevious,
    };
  }

  /** Ends the stream: finishes the open utterance, if it held speech. */
  flush(): DictationSegment | null {
    const open = this.open;
    if (open === null) return null;
    return this.close(open, open.frames.length - open.quietFrames + this.options.tailFrames, false);
  }

  /**
   * Finishes `open` after its first `keep` frames. A split carries the rest on
   * as a new open utterance that continues this one.
   */
  private close(open: OpenSegment, keep: number, split: boolean): DictationSegment | null {
    const kept = Math.min(open.frames.length, keep);
    this.open = null;
    if (split && kept < open.frames.length) {
      const frames = open.frames.slice(kept);
      const levels = open.levels.slice(kept);
      this.open = {
        id: this.nextId++,
        frames,
        levels,
        continuesPrevious: true,
        speechFrames: levels.filter((level) => this.isSpeech(level)).length,
        quietFrames: 0,
      };
    }
    if (open.speechFrames < this.options.minSpeechFrames) return null;
    return {
      id: open.id,
      samples: concatFrames(open.frames.slice(0, kept)),
      continuesPrevious: open.continuesPrevious,
    };
  }
}

export interface TranscriptPart {
  readonly text: string;
  readonly continuesPrevious: boolean;
}

const SENTENCE_END = /[.!?…]["'”’)\]]*$/u;
// "I", "I'm", "I'll" and acronyms keep their capitals.
const CAPITALIZED_WORD = /^([A-Z])(?=[a-z])(?!['’])/u;

/**
 * Joins the transcripts of consecutive utterances. Where an utterance was cut
 * mid-sentence, the model ends the first half with a period and capitalizes the
 * second; both are undone so the sentence reads as one.
 */
export function joinTranscript(parts: ReadonlyArray<TranscriptPart>): string {
  let result = "";
  for (const part of parts) {
    let text = part.text.replace(/\s+/gu, " ").trim();
    if (text.length === 0) continue;
    if (result.length === 0) {
      result = text;
      continue;
    }
    if (part.continuesPrevious) {
      if (result.endsWith(".") && !result.endsWith("..")) result = result.slice(0, -1);
      if (!SENTENCE_END.test(result) && !/^I\b/u.test(text)) {
        text = text.replace(CAPITALIZED_WORD, (letter) => letter.toLowerCase());
      }
    }
    result = `${result} ${text}`;
  }
  return result;
}

/**
 * The text that goes into the prompt at `cursor`: the transcript with a space
 * on either side where it would otherwise run into a word.
 */
export function dictationInsertion(prompt: string, cursor: number, transcript: string): string {
  const text = transcript.trim();
  if (text.length === 0) return "";
  const before = prompt[cursor - 1];
  const after = prompt[cursor];
  const leading = before !== undefined && !/\s/u.test(before) ? " " : "";
  const trailing = after !== undefined && !/[\s.,!?;:)\]}]/u.test(after) ? " " : "";
  return `${leading}${text}${trailing}`;
}
