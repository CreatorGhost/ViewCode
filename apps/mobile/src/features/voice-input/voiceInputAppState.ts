import type { VoiceInputState } from "@t3tools/client-runtime/voice-input";

/**
 * Whether an app state change ends voice input. iOS reports `inactive` while
 * its microphone permission dialog is open; Android pauses the activity for
 * that dialog, which React Native reports as `background`, so Android keeps
 * preparing through it. A real leave after that still ends the recording:
 * Android stops a background app's microphone and the recorder reports it.
 */
export function voiceInputStopsForAppState(
  platform: string,
  nextState: string,
  phase: VoiceInputState["phase"],
): boolean {
  if (nextState !== "background") return false;
  return !(platform === "android" && phase === "preparing");
}
