import type { VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import { useCallback, useEffect, useState } from "react";

import {
  AndroidSpeechRecorder,
  forgetAndroidSpeechTranscript,
} from "../../native/androidSpeechRecorder";

/**
 * Android's dictation recorder recognizes speech live; see androidSpeechRecorder.ts.
 * `onStatus` must be stable: the recorder keeps the first one.
 */
export function useVoiceRecorder(onStatus: (status: VoiceRecorderStatus) => void) {
  const [recorder] = useState(() => new AndroidSpeechRecorder(onStatus));
  useEffect(() => () => recorder.release(), [recorder]);
  const getStatus = useCallback(() => recorder.getStatus(), [recorder]);
  return { recorder, getStatus, deleteRecording: forgetAndroidSpeechTranscript };
}
