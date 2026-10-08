import type { VoiceRecorderStatus } from "@t3tools/client-runtime/voice-input";
import { File } from "expo-file-system";
import { RecordingPresets, useAudioRecorder, type RecordingStatus } from "expo-audio";
import { useCallback } from "react";

const VOICE_RECORDING_OPTIONS = {
  ...RecordingPresets.HIGH_QUALITY,
  isMeteringEnabled: true,
};

function deleteRecordingFile(uri: string) {
  new File(uri).delete();
}

/** The composer's dictation recorder: an audio file the local transcriber reads afterwards. */
export function useVoiceRecorder(onStatus: (status: VoiceRecorderStatus) => void) {
  const handleStatus = useCallback(
    (status: RecordingStatus) =>
      onStatus({
        isFinished: status.isFinished,
        hasError: status.hasError || status.mediaServicesDidReset === true,
        error: status.error,
        url: status.url,
      }),
    [onStatus],
  );
  const recorder = useAudioRecorder(VOICE_RECORDING_OPTIONS, handleStatus);
  const getStatus = useCallback(() => recorder.getStatus(), [recorder]);
  return { recorder, getStatus, deleteRecording: deleteRecordingFile };
}
