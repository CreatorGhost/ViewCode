import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { readAloudVoiceChoices } from "~/lib/readAloud.logic";
import {
  isReadAloudSupported,
  speakReadAloud,
  stopReadAloud,
  useReadAloudStore,
  useSystemVoices,
} from "~/lib/readAloudPlayer";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SYSTEM_DEFAULT_VOICE = "system-default";
const PREVIEW_KEY = "settings:read-aloud-preview";
const PREVIEW_TEXT = "This is how replies sound when ViewCode reads them aloud.";
const RATE_OPTIONS = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;

function rateLabel(rate: number): string {
  return rate === 1 ? "Normal" : `${rate}×`;
}

/** Settings -> Appearance -> Read aloud. Hidden where the browser has no speech voices. */
export function ReadAloudSettings() {
  if (!isReadAloudSupported()) return null;
  return <ReadAloudSettingsSection />;
}

function ReadAloudSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const voices = useSystemVoices();
  const previewing = useReadAloudStore((state) => state.playingKey === PREVIEW_KEY);
  const selectedVoiceURI = settings.readAloudVoice?.voiceURI ?? null;
  const voiceChoices = readAloudVoiceChoices(voices, navigator.language, selectedVoiceURI);
  const selectedVoiceName =
    voices.find((voice) => voice.voiceURI === selectedVoiceURI)?.name ?? "System default";

  return (
    <SettingsSection id="appearance-read-aloud" title="Read aloud">
      <SettingsRow
        {...searchableSetting("read-aloud-voice")}
        description="Voice used by the speaker button on replies. More voices can be added in your system's speech settings."
        resetAction={
          settings.readAloudVoice !== DEFAULT_CLIENT_SETTINGS.readAloudVoice ? (
            <SettingResetButton
              label="read aloud voice"
              onClick={() =>
                updateSettings({ readAloudVoice: DEFAULT_CLIENT_SETTINGS.readAloudVoice })
              }
            />
          ) : null
        }
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Select
              value={selectedVoiceURI ?? SYSTEM_DEFAULT_VOICE}
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                updateSettings({
                  readAloudVoice:
                    value === SYSTEM_DEFAULT_VOICE ? null : { engine: "system", voiceURI: value },
                });
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Read aloud voice">
                <SelectValue>{selectedVoiceName}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value={SYSTEM_DEFAULT_VOICE}>
                  System default
                </SelectItem>
                {voiceChoices.map((voice) => (
                  <SelectItem hideIndicator key={voice.voiceURI} value={voice.voiceURI}>
                    {voice.name} ({voice.lang})
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() =>
                previewing ? stopReadAloud() : speakReadAloud(PREVIEW_KEY, PREVIEW_TEXT, settings)
              }
            >
              {previewing ? "Stop" : "Preview"}
            </Button>
          </div>
        }
      />
      <SettingsRow
        {...searchableSetting("read-aloud-speed")}
        description="How fast replies are read."
        resetAction={
          settings.readAloudRate !== DEFAULT_CLIENT_SETTINGS.readAloudRate ? (
            <SettingResetButton
              label="read aloud speed"
              onClick={() =>
                updateSettings({ readAloudRate: DEFAULT_CLIENT_SETTINGS.readAloudRate })
              }
            />
          ) : null
        }
        control={
          <Select
            value={String(settings.readAloudRate)}
            onValueChange={(value) => {
              const rate = RATE_OPTIONS.find((option) => String(option) === value);
              if (rate !== undefined) updateSettings({ readAloudRate: rate });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Read aloud speed">
              <SelectValue>{rateLabel(settings.readAloudRate)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {RATE_OPTIONS.map((rate) => (
                <SelectItem hideIndicator key={rate} value={String(rate)}>
                  {rateLabel(rate)}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}
