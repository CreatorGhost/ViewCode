import {
  DEFAULT_CLIENT_SETTINGS,
  type EnvironmentId,
  type VoiceModelTier,
  type VoiceModelTierState,
  VOICE_MODEL_TIERS,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  NATURAL_VOICE_TIER_BYTES,
  NATURAL_VOICES,
  readAloudVoiceChoices,
  resolveReadAloudVoice,
} from "~/lib/readAloud.logic";
import {
  isReadAloudSupported,
  speakReadAloud,
  stopReadAloud,
  unloadNaturalVoice,
  useReadAloudStore,
  useSystemVoices,
} from "~/lib/readAloudPlayer";
import { isKokoroSupported } from "~/lib/readAloudKokoro";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  useReadAloudEnvironmentId,
  useVoiceModels,
  voiceModelEnvironment,
} from "~/state/voiceModels";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const SYSTEM_ENGINE = "system";
const SYSTEM_DEFAULT_VOICE = "system-default";
const PREVIEW_KEY = "settings:read-aloud-preview";
const PREVIEW_TEXT = "This is how replies sound when ViewCode reads them aloud.";
const RATE_OPTIONS = [0.8, 1, 1.25, 1.5, 1.75, 2] as const;
// Model, tokenizer and the offered voices; the exact size shows once the manifest is read.
const TIER_LABELS: Record<VoiceModelTier, string> = {
  small: "Natural voice, small (about 95 MB)",
  medium: "Natural voice, medium (about 165 MB)",
  large: "Natural voice, large (about 330 MB)",
};

function rateLabel(rate: number): string {
  return rate === 1 ? "Normal" : `${rate}×`;
}

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Settings -> Appearance -> Read aloud. Hidden where no voice can read. */
export function ReadAloudSettings() {
  if (!isReadAloudSupported()) return null;
  return <ReadAloudSettingsSection />;
}

function ReadAloudSettingsSection() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const systemVoices = useSystemVoices();
  const previewing = useReadAloudStore((state) => state.playingKey === PREVIEW_KEY);
  const environmentId = useReadAloudEnvironmentId();
  const download = useAtomCommand(voiceModelEnvironment.download, { reportFailure: false });
  const voice = resolveReadAloudVoice(settings.readAloudVoice);
  const naturalSupported = isKokoroSupported();
  const engineValue = voice.engine === "kokoro" ? voice.tier : SYSTEM_ENGINE;
  const selectedSystemVoiceURI = voice.engine === "system" ? voice.voiceURI : null;
  const systemVoiceChoices = readAloudVoiceChoices(
    systemVoices,
    navigator.language,
    selectedSystemVoiceURI,
  );
  const selectedVoiceName =
    voice.engine === "kokoro"
      ? (NATURAL_VOICES.find((each) => each.id === voice.voice)?.name ?? voice.voice)
      : (systemVoices.find((each) => each.voiceURI === selectedSystemVoiceURI)?.name ??
        "System default");

  const chooseEngine = (value: string) => {
    if (value === SYSTEM_ENGINE) {
      updateSettings({ readAloudVoice: { engine: "system", voiceURI: null } });
      return;
    }
    const tier = VOICE_MODEL_TIERS.find((each) => each === value);
    if (!tier) return;
    updateSettings({
      readAloudVoice: {
        engine: "kokoro",
        voice: voice.engine === "kokoro" ? voice.voice : NATURAL_VOICES[0].id,
        tier,
      },
    });
    // Choosing a tier downloads it once; a tier already here is left alone.
    if (environmentId) void download({ environmentId, input: { tier } });
  };

  return (
    <SettingsSection id="appearance-read-aloud" title="Read aloud">
      <SettingsRow
        {...searchableSetting("read-aloud-engine")}
        description="The natural voice runs on your device. It downloads once from ViewCode's GitHub release and is kept on the computer running ViewCode. The system voice needs no download."
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
        status={
          voice.engine === "kokoro" ? (
            <NaturalVoiceStatus environmentId={environmentId} tier={voice.tier} />
          ) : null
        }
        control={
          <Select
            value={engineValue}
            onValueChange={(value) => {
              if (typeof value === "string") chooseEngine(value);
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-72" aria-label="Read aloud engine">
              <SelectValue>
                {engineValue === SYSTEM_ENGINE
                  ? "System voice (no download)"
                  : TIER_LABELS[engineValue]}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {naturalSupported
                ? VOICE_MODEL_TIERS.map((tier) => (
                    <SelectItem hideIndicator key={tier} value={tier}>
                      {TIER_LABELS[tier]}
                    </SelectItem>
                  ))
                : null}
              <SelectItem hideIndicator value={SYSTEM_ENGINE}>
                System voice (no download)
              </SelectItem>
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("read-aloud-voice")}
        description={
          voice.engine === "kokoro"
            ? "Voice used by the speaker button on replies. Natural voices speak English."
            : "Voice used by the speaker button on replies. More voices can be added in your system's speech settings."
        }
        control={
          <div className="flex w-full items-center gap-2 sm:w-auto">
            <Select
              value={
                voice.engine === "kokoro"
                  ? voice.voice
                  : (selectedSystemVoiceURI ?? SYSTEM_DEFAULT_VOICE)
              }
              onValueChange={(value) => {
                if (typeof value !== "string") return;
                if (voice.engine === "kokoro") {
                  updateSettings({ readAloudVoice: { ...voice, voice: value } });
                } else {
                  updateSettings({
                    readAloudVoice: {
                      engine: "system",
                      voiceURI: value === SYSTEM_DEFAULT_VOICE ? null : value,
                    },
                  });
                }
              }}
            >
              <SelectTrigger size="sm" className="w-full sm:w-56" aria-label="Read aloud voice">
                <SelectValue>{selectedVoiceName}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {voice.engine === "kokoro" ? (
                  NATURAL_VOICES.map((each) => (
                    <SelectItem hideIndicator key={each.id} value={each.id}>
                      {each.name} ({each.accent})
                    </SelectItem>
                  ))
                ) : (
                  <>
                    <SelectItem hideIndicator value={SYSTEM_DEFAULT_VOICE}>
                      System default
                    </SelectItem>
                    {systemVoiceChoices.map((each) => (
                      <SelectItem hideIndicator key={each.voiceURI} value={each.voiceURI}>
                        {each.name} ({each.lang})
                      </SelectItem>
                    ))}
                  </>
                )}
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

/** The chosen tier's download: progress, retry, cancel, and removal of every downloaded tier. */
function NaturalVoiceStatus({
  environmentId,
  tier,
}: {
  environmentId: EnvironmentId | null;
  tier: VoiceModelTier;
}) {
  const { state, unavailable } = useVoiceModels(environmentId);
  const download = useAtomCommand(voiceModelEnvironment.download, { reportFailure: false });
  const cancel = useAtomCommand(voiceModelEnvironment.cancel, { reportFailure: false });
  const remove = useAtomCommand(voiceModelEnvironment.remove, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  if (!isKokoroSupported()) {
    return <p>This browser can't run the natural voice, so the system voice reads replies.</p>;
  }
  if (environmentId === null || unavailable) {
    return (
      <p>
        The natural voice needs a connected ViewCode server that supports it. Until then the system
        voice reads replies.
      </p>
    );
  }
  if (state === null) return <p>Checking the natural voice…</p>;
  const current: VoiceModelTierState | undefined = state.tiers.find((each) => each.tier === tier);
  const anyDownloaded = state.tiers.some((each) => each.phase === "ready");
  const run = async <A, E>(request: () => Promise<AtomCommandResult<A, E>>) => {
    setError(null);
    const result = await request();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
    }
  };
  const target = { environmentId, input: { tier } };
  const totalBytes = current?.totalBytes ?? NATURAL_VOICE_TIER_BYTES[tier];

  return (
    <div className="space-y-2">
      {current?.phase === "downloading" ? (
        <>
          <div
            role="progressbar"
            aria-label="Natural voice download"
            aria-valuemin={0}
            aria-valuemax={totalBytes}
            aria-valuenow={current.downloadedBytes}
            className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full bg-primary"
              style={{ width: `${Math.min(100, (current.downloadedBytes / totalBytes) * 100)}%` }}
            />
          </div>
          <p className="tabular-nums">
            Downloading {megabytes(current.downloadedBytes)} of {megabytes(totalBytes)}. The system
            voice reads until it's ready.
          </p>
        </>
      ) : current?.phase === "ready" ? (
        <p>Downloaded ({megabytes(totalBytes)}). Works offline.</p>
      ) : current?.phase === "failed" ? (
        <p>{current.message ?? "The download failed."} The system voice reads until it works.</p>
      ) : (
        <p>
          Not downloaded yet. It downloads ({megabytes(totalBytes)}) the first time a reply is read.
        </p>
      )}
      {error ? <p className="text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {current?.phase === "downloading" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void run(() => cancel(target))}
          >
            Cancel
          </Button>
        ) : current?.phase === "ready" ? null : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void run(() => download(target))}
          >
            {current?.phase === "failed" ? "Try again" : "Download now"}
          </Button>
        )}
        {anyDownloaded ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              unloadNaturalVoice();
              void run(() => remove({ environmentId, input: {} }));
            }}
          >
            Remove downloaded voice
          </Button>
        ) : null}
      </div>
    </div>
  );
}
