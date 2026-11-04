// Runs on the audio rendering thread: turns each 128-sample render quantum of
// the microphone into 16 kHz mono and posts whole 50 ms frames with their level.
import { Downsampler, FrameChunker, frameLevel, mixToMono } from "./dictationAudio";

// AudioWorkletGlobalScope, which the DOM typings leave out.
declare const sampleRate: number;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
}
declare function registerProcessor(
  name: string,
  processor: new () => AudioWorkletProcessor & {
    process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean;
  },
): void;

export interface DictationCaptureFrame {
  readonly frame: Float32Array;
  readonly level: number;
}

class DictationCaptureProcessor extends AudioWorkletProcessor {
  private readonly downsampler = new Downsampler(sampleRate);
  private readonly chunker = new FrameChunker();
  private mono: Float32Array = new Float32Array(128);

  process(inputs: ReadonlyArray<ReadonlyArray<Float32Array>>): boolean {
    const channels = inputs[0];
    if (!channels || channels.length === 0) return true;
    this.mono = mixToMono(channels, this.mono);
    for (const frame of this.chunker.push(this.downsampler.push(this.mono))) {
      const message: DictationCaptureFrame = { frame, level: frameLevel(frame) };
      this.port.postMessage(message, [frame.buffer]);
    }
    return true;
  }
}

registerProcessor("dictation-capture", DictationCaptureProcessor);
