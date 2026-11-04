import type { DictationErrorReason } from "./dictation.logic";
import type { DictationCaptureFrame } from "./dictationCapture.worklet";
// Bundled like a worker (so its imports resolve) and served from the app's own
// origin, which the desktop app's script policy allows; a blob: worklet it does not.
import captureWorkletUrl from "./dictationCapture.worklet.ts?worker&url";

export class DictationCaptureError extends Error {
  readonly reason: DictationErrorReason;

  constructor(reason: DictationErrorReason, message: string) {
    super(message);
    this.name = "DictationCaptureError";
    this.reason = reason;
  }
}

export interface DictationCapture {
  /** Releases the microphone; the browser's recording indicator goes away. */
  stop(): void;
}

/** Whether this browser can capture and transcribe at all. */
export function isDictationSupported(): boolean {
  return (
    typeof navigator === "object" &&
    typeof navigator.mediaDevices?.getUserMedia === "function" &&
    typeof globalThis.AudioWorkletNode === "function" &&
    typeof Worker === "function" &&
    typeof WebAssembly === "object"
  );
}

function blockedMessage(): string {
  return window.desktopBridge
    ? "Microphone access is off for ViewCode. Turn it on in your system's privacy settings for the microphone, then try again."
    : "Microphone access is blocked for this site. Allow it in the browser's site settings, then try again.";
}

function captureError(error: unknown): DictationCaptureError {
  const name = error instanceof DOMException ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "SecurityError":
      return new DictationCaptureError("permission-denied", blockedMessage());
    case "NotFoundError":
    case "OverconstrainedError":
      return new DictationCaptureError(
        "no-microphone",
        "No microphone was found. Connect one, then try again.",
      );
    case "NotReadableError":
    case "AbortError":
      return new DictationCaptureError(
        "microphone-busy",
        "The microphone is in use by another app, or couldn't be started. Close the other app, then try again.",
      );
    default:
      return new DictationCaptureError("microphone-busy", "Couldn't start the microphone.");
  }
}

/**
 * Opens the microphone and streams 16 kHz mono frames of 50 ms to `onFrame`,
 * with their level. `onEnded` runs if the device goes away mid-dictation.
 */
export async function openDictationCapture(options: {
  readonly onFrame: (frame: Float32Array, level: number) => void;
  readonly onEnded: () => void;
}): Promise<DictationCapture> {
  if (!isDictationSupported()) {
    throw new DictationCaptureError("unsupported", "This browser can't dictate.");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    throw captureError(error);
  }
  const stopTracks = () => {
    for (const track of stream.getTracks()) track.stop();
  };
  // The context runs at the device's own rate; the worklet converts to 16 kHz,
  // because some browsers refuse to connect a microphone to a context at another rate.
  const context = new AudioContext({ latencyHint: "interactive" });
  try {
    await context.audioWorklet.addModule(captureWorkletUrl);
    await context.resume();
  } catch {
    stopTracks();
    void context.close();
    throw new DictationCaptureError("unsupported", "Couldn't start dictation's audio processing.");
  }
  const source = context.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(context, "dictation-capture", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCountMode: "explicit",
    channelCount: 1,
  });
  const onMessage = ({ data }: MessageEvent<DictationCaptureFrame>) => {
    options.onFrame(data.frame, data.level);
  };
  node.port.addEventListener("message", onMessage);
  // A port listened to with addEventListener delivers nothing until started.
  node.port.start();
  source.connect(node);
  // A node the graph doesn't pull from may never run; its output stays silent.
  node.connect(context.destination);

  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    node.port.removeEventListener("message", onMessage);
    node.port.close();
    source.disconnect();
    node.disconnect();
    stopTracks();
    void context.close();
  };
  for (const track of stream.getAudioTracks()) {
    track.addEventListener("ended", () => {
      if (stopped) return;
      stop();
      options.onEnded();
    });
  }
  return { stop };
}
