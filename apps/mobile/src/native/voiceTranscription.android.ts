import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type VoiceTranscriber,
} from "@t3tools/client-runtime/voice-input";

import {
  androidSpeechLocale,
  isAndroidSpeechRecognitionAvailable,
  takeAndroidSpeechTranscript,
} from "./androidSpeechRecorder";

/**
 * Android transcribes while recording (androidSpeechRecorder.ts), so this
 * only collects the transcript the recorder left under the recording's uri.
 */
export function getLocalVoiceTranscriber(): VoiceTranscriber | null {
  if (!isAndroidSpeechRecognitionAvailable()) return null;
  return {
    prepare: async ({ signal }) => {
      throwIfVoiceTranscriptionAborted(signal);
      return {
        locale: androidSpeechLocale(),
        transcribe: async (uri, options) => {
          throwIfVoiceTranscriptionAborted(options.signal);
          const transcript = takeAndroidSpeechTranscript(uri);
          if (transcript === null) {
            throw new VoiceTranscriptionError(
              "transcription-failed",
              "Speech recognition did not return a transcript.",
            );
          }
          return transcript;
        },
      };
    },
  };
}
