import type { VoiceRecorder, VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import {
  ExpoSpeechRecognitionModule,
  type ExpoSpeechRecognitionErrorCode,
} from "expo-speech-recognition";
import { Platform } from "react-native";

/**
 * Android dictation. Android cannot transcribe the composer's recorded file,
 * so this "recorder" runs the system SpeechRecognizer live while the user
 * speaks. Its uri names the transcript, which the Android transcriber
 * (voiceTranscription.android.ts) collects when the controller asks.
 */

const URI_SCHEME = "speech-recognition://";
const transcripts = new Map<string, string>();

export function isAndroidSpeechUri(uri: string): boolean {
  return uri.startsWith(URI_SCHEME);
}

/** Hands over a finished recording's transcript once; null when there is none. */
export function takeAndroidSpeechTranscript(uri: string): string | null {
  const transcript = transcripts.get(uri);
  transcripts.delete(uri);
  return transcript ?? null;
}

export function forgetAndroidSpeechTranscript(uri: string): void {
  transcripts.delete(uri);
}

let recognitionAvailable: boolean | null = null;

/** Asked once per launch: a recognition service is installed and enabled. */
export function isAndroidSpeechRecognitionAvailable(): boolean {
  if (recognitionAvailable === null) {
    try {
      recognitionAvailable = ExpoSpeechRecognitionModule.isRecognitionAvailable();
    } catch {
      recognitionAvailable = false;
    }
  }
  return recognitionAvailable;
}

export function androidSpeechLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

/** Errors that only mean the user said nothing: the controller reports an empty transcript. */
const SILENT_ENDINGS = new Set<ExpoSpeechRecognitionErrorCode>([
  "no-speech",
  "speech-timeout",
  "aborted",
]);

const ERROR_MESSAGES: Partial<Record<ExpoSpeechRecognitionErrorCode, string>> = {
  "not-allowed": "Microphone access is off for ViewCode.",
  "language-not-supported": "Voice input does not support this device language.",
  "service-not-allowed": "Speech recognition is not available on this device.",
  network: "Speech recognition needs a network connection on this device.",
  busy: "Speech recognition is busy. Try again.",
};

type Subscription = { remove(): void };

export class AndroidSpeechRecorder implements VoiceRecorder {
  uri: string | null = null;
  private active = false;
  private stopping = false;
  private startedAt = 0;
  private level: number | undefined = undefined;
  private finals: string[] = [];
  private partial = "";
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private subscriptions: Subscription[] = [];
  private ended: (() => void) | null = null;

  constructor(private readonly onStatus: (status: VoiceRecorderStatus) => void) {}

  async prepareToRecordAsync(): Promise<void> {
    if (this.uri) forgetAndroidSpeechTranscript(this.uri);
    this.uri = `${URI_SCHEME}${Date.now()}`;
    this.finals = [];
    this.partial = "";
    this.level = undefined;
  }

  record(options: { readonly forDuration: number }): void {
    this.listen();
    this.active = true;
    this.stopping = false;
    this.startedAt = Date.now();
    this.limitTimer = setTimeout(() => {
      // The limit ends a recording the same way the file recorder's does.
      this.stopping = false;
      ExpoSpeechRecognitionModule.stop();
    }, options.forDuration * 1_000);
    ExpoSpeechRecognitionModule.start({
      lang: androidSpeechLocale(),
      interimResults: true,
      // Android 12 and below stop at the first pause instead.
      continuous: typeof Platform.Version === "number" && Platform.Version >= 33,
      addsPunctuation: true,
      maxAlternatives: 1,
      volumeChangeEventOptions: { enabled: true, intervalMillis: 80 },
    });
  }

  async stop(): Promise<void> {
    if (!this.active) return;
    this.stopping = true;
    const ended = new Promise<void>((resolve) => {
      this.ended = resolve;
    });
    ExpoSpeechRecognitionModule.stop();
    await ended;
  }

  /** Matches the shape the composer samples from expo-audio's recorder. */
  getStatus() {
    return {
      isRecording: this.active,
      // volumechange runs from -2 (silence) to 10; spread it over -60…0 dB.
      metering: this.level === undefined ? undefined : -60 + Math.max(0, this.level) * 6,
      durationMillis: this.active ? Date.now() - this.startedAt : 0,
    };
  }

  /** Stops listening without keeping anything, e.g. when the composer unmounts. */
  release(): void {
    if (this.active) ExpoSpeechRecognitionModule.abort();
    this.finish();
    if (this.uri) forgetAndroidSpeechTranscript(this.uri);
  }

  private listen() {
    this.unlisten();
    this.subscriptions = [
      ExpoSpeechRecognitionModule.addListener("result", (event) => {
        const transcript = event.results[0]?.transcript ?? "";
        if (event.isFinal) {
          if (transcript.trim()) this.finals.push(transcript.trim());
          this.partial = "";
        } else {
          this.partial = transcript.trim();
        }
      }),
      ExpoSpeechRecognitionModule.addListener("volumechange", (event) => {
        this.level = event.value;
      }),
      ExpoSpeechRecognitionModule.addListener("error", (event) => {
        if (SILENT_ENDINGS.has(event.error)) return;
        const uri = this.uri;
        this.finish();
        this.onStatus({
          isFinished: false,
          hasError: true,
          error: ERROR_MESSAGES[event.error] ?? "Speech recognition failed.",
          url: uri,
        });
      }),
      ExpoSpeechRecognitionModule.addListener("end", () => {
        if (!this.active) return;
        const uri = this.uri;
        const stopRequested = this.stopping;
        if (uri) transcripts.set(uri, [...this.finals, this.partial].filter(Boolean).join(" "));
        this.finish();
        // An ending nobody asked for (the limit, or Android 12's first pause)
        // finishes the recording like a recorder that ran out of time.
        if (!stopRequested) {
          this.onStatus({ isFinished: true, hasError: false, error: null, url: uri });
        }
      }),
    ];
  }

  private finish() {
    this.active = false;
    this.stopping = false;
    if (this.limitTimer !== null) clearTimeout(this.limitTimer);
    this.limitTimer = null;
    this.unlisten();
    this.ended?.();
    this.ended = null;
  }

  private unlisten() {
    for (const subscription of this.subscriptions) subscription.remove();
    this.subscriptions = [];
  }
}
