// Dictation's audio path, shared by the capture worklet and its tests: the
// microphone's samples become 16 kHz mono frames of 50 ms, which drive both the
// waveform (one bar per frame) and the speech model.

/** What the speech model expects. */
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_FRAME_MS = 50;
export const DICTATION_FRAME_SAMPLES = (DICTATION_SAMPLE_RATE * DICTATION_FRAME_MS) / 1000;

/**
 * Converts a stream from `inputRate` to `outputRate`. Going down, each output
 * sample averages the input samples it covers, a box filter that keeps most of
 * the aliasing out of speech; going up (a rare 8 kHz microphone) it repeats them.
 */
export class Downsampler {
  private readonly ratio: number;
  private sum = 0;
  private count = 0;
  /** Input samples seen since the last emitted output, as a fraction of `ratio`. */
  private position = 0;

  constructor(inputRate: number, outputRate: number = DICTATION_SAMPLE_RATE) {
    this.ratio = inputRate / outputRate;
  }

  push(input: Float32Array): Float32Array {
    if (this.ratio === 1) return input.slice();
    const output = new Float32Array(Math.ceil((input.length + this.position + 1) / this.ratio) + 1);
    let written = 0;
    if (this.ratio < 1) {
      for (const sample of input) {
        this.position += 1;
        while (this.position > 0) {
          output[written++] = sample;
          this.position -= this.ratio;
        }
      }
      return output.subarray(0, written);
    }
    for (const sample of input) {
      this.sum += sample;
      this.count += 1;
      this.position += 1;
      if (this.position >= this.ratio) {
        output[written++] = this.sum / this.count;
        this.sum = 0;
        this.count = 0;
        this.position -= this.ratio;
      }
    }
    return output.subarray(0, written);
  }
}

/** Cuts a stream into frames of `size` samples; a short tail waits for the next push. */
export class FrameChunker {
  private readonly size: number;
  private pending: Float32Array;
  private filled = 0;

  constructor(size: number = DICTATION_FRAME_SAMPLES) {
    this.size = size;
    this.pending = new Float32Array(size);
  }

  push(samples: Float32Array): Float32Array[] {
    const frames: Float32Array[] = [];
    let offset = 0;
    while (offset < samples.length) {
      const taken = Math.min(this.size - this.filled, samples.length - offset);
      this.pending.set(samples.subarray(offset, offset + taken), this.filled);
      this.filled += taken;
      offset += taken;
      if (this.filled === this.size) {
        // Each frame is transferred to the page, so it gets its own buffer.
        frames.push(this.pending);
        this.pending = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return frames;
  }
}

/** Root mean square: 0 for silence, about 0.02–0.2 for speech near the microphone. */
export function frameLevel(frame: Float32Array): number {
  if (frame.length === 0) return 0;
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / frame.length);
}

/** Averages the channels of one render quantum into `into`, which it returns. */
export function mixToMono(channels: ReadonlyArray<Float32Array>, into: Float32Array): Float32Array {
  const length = channels[0]?.length ?? 0;
  const mono = into.length === length ? into : new Float32Array(length);
  if (channels.length === 1) {
    mono.set(channels[0]!);
    return mono;
  }
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    for (const channel of channels) sum += channel[index] ?? 0;
    mono[index] = sum / channels.length;
  }
  return mono;
}
