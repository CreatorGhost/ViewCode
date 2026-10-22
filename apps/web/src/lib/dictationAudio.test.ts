import { describe, expect, it } from "vite-plus/test";

import {
  DICTATION_FRAME_SAMPLES,
  Downsampler,
  FrameChunker,
  frameLevel,
  mixToMono,
} from "./dictationAudio";

/** A sine wave at `frequency` Hz, `seconds` long, sampled at `rate`. */
function tone(frequency: number, rate: number, seconds: number, amplitude = 0.5): Float32Array {
  const samples = new Float32Array(Math.round(rate * seconds));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin((2 * Math.PI * frequency * index) / rate);
  }
  return samples;
}

/** Feeds `input` in 128-sample render quanta, as an AudioWorklet does. */
function inQuanta(downsampler: Downsampler, input: Float32Array): Float32Array {
  const parts: Float32Array[] = [];
  for (let offset = 0; offset < input.length; offset += 128) {
    parts.push(downsampler.push(input.subarray(offset, offset + 128)));
  }
  const output = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe("Downsampler", () => {
  it.each([48_000, 44_100, 96_000, 22_050])(
    "keeps time when going from %i Hz to 16 kHz",
    (rate) => {
      const output = inQuanta(new Downsampler(rate), tone(440, rate, 2));
      // Two seconds stay two seconds, whatever the quantum boundaries.
      expect(Math.abs(output.length - 32_000)).toBeLessThanOrEqual(1);
    },
  );

  it("keeps a speech-band tone's level", () => {
    const output = inQuanta(new Downsampler(48_000), tone(300, 48_000, 1));
    // A 0.5 sine has an RMS of about 0.354; the box filter barely touches 300 Hz.
    expect(frameLevel(output)).toBeCloseTo(0.354, 1);
  });

  it("attenuates a tone above the new Nyquist frequency instead of folding it into speech", () => {
    const passed = frameLevel(inQuanta(new Downsampler(48_000), tone(15_000, 48_000, 1)));
    expect(passed).toBeLessThan(0.2);
  });

  it("passes 16 kHz through and repeats samples from a slower microphone", () => {
    const input = tone(200, 16_000, 0.1);
    expect(new Downsampler(16_000).push(input)).toEqual(input);
    expect(inQuanta(new Downsampler(8_000), tone(200, 8_000, 1)).length).toBe(16_000);
  });
});

describe("FrameChunker", () => {
  it("emits whole 50 ms frames and carries the remainder over", () => {
    const chunker = new FrameChunker();
    const ramp = Float32Array.from({ length: 2_000 }, (_, index) => index);
    const first = chunker.push(ramp.subarray(0, 1_000));
    expect(first).toHaveLength(1);
    expect(first[0]).toHaveLength(DICTATION_FRAME_SAMPLES);
    const second = chunker.push(ramp.subarray(1_000));
    expect(second).toHaveLength(1);
    // The second frame starts where the first stopped: no sample is lost or repeated.
    expect(second[0]![0]).toBe(DICTATION_FRAME_SAMPLES);
    expect(second[0]![DICTATION_FRAME_SAMPLES - 1]).toBe(2 * DICTATION_FRAME_SAMPLES - 1);
  });

  it("gives every frame its own buffer, since frames are transferred", () => {
    const frames = new FrameChunker(4).push(new Float32Array(12));
    expect(new Set(frames.map((frame) => frame.buffer)).size).toBe(3);
  });
});

describe("mixToMono", () => {
  it("averages the channels", () => {
    const mono = mixToMono(
      [Float32Array.from([1, 0.5]), Float32Array.from([0, -0.5])],
      new Float32Array(2),
    );
    expect([...mono]).toEqual([0.5, 0]);
  });
});
