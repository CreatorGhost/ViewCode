import {
  DEFAULT_CLIENT_SETTINGS,
  DICTATION_MODEL_KEY,
  type EnvironmentId,
} from "@t3tools/contracts";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { isDictationSupported } from "~/lib/dictationCapture";
import { closeDictationModel } from "~/lib/dictationModel";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  useReadAloudEnvironmentId,
  useVoiceModels,
  voiceModelEnvironment,
} from "~/state/voiceModels";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// The q8 encoder and decoder plus the tokenizer; the exact size shows once the manifest is read.
const DICTATION_MODEL_BYTES = 65_000_000;

function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}

/** Settings -> Appearance -> Dictation: the composer's microphone and its speech model. */
export function DictationSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const environmentId = useReadAloudEnvironmentId();

  return (
    <SettingsSection id="appearance-dictation" title="Dictation">
      <SettingsRow
        {...searchableSetting("dictation")}
        description="A microphone in the composer turns speech into text where your cursor is. Speech is transcribed on your device by a model that downloads once and is kept on the computer running ViewCode; your audio is never sent anywhere."
        resetAction={
          settings.dictationEnabled !== DEFAULT_CLIENT_SETTINGS.dictationEnabled ? (
            <SettingResetButton
              label="dictation"
              onClick={() =>
                updateSettings({ dictationEnabled: DEFAULT_CLIENT_SETTINGS.dictationEnabled })
              }
            />
          ) : null
        }
        status={
          settings.dictationEnabled ? <DictationModelStatus environmentId={environmentId} /> : null
        }
        control={
          <Switch
            checked={settings.dictationEnabled}
            onCheckedChange={(checked) => updateSettings({ dictationEnabled: Boolean(checked) })}
            aria-label="Dictation"
          />
        }
      />
    </SettingsSection>
  );
}

/** The speech model's download: progress, retry, cancel and removal. */
function DictationModelStatus({ environmentId }: { environmentId: EnvironmentId | null }) {
  const { state, unavailable } = useVoiceModels(environmentId);
  const download = useAtomCommand(voiceModelEnvironment.download, { reportFailure: false });
  const cancel = useAtomCommand(voiceModelEnvironment.cancel, { reportFailure: false });
  const remove = useAtomCommand(voiceModelEnvironment.remove, { reportFailure: false });
  const [error, setError] = useState<string | null>(null);
  if (!isDictationSupported()) return <p>This browser can't dictate.</p>;
  const model = state?.dictation;
  if (environmentId === null || unavailable || (state !== null && model === undefined)) {
    return <p>Dictation needs a connected ViewCode server that supports it.</p>;
  }
  if (model === undefined) return <p>Checking the speech model…</p>;
  const run = async <A, E>(request: () => Promise<AtomCommandResult<A, E>>) => {
    setError(null);
    const result = await request();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "That didn't work. Try again.");
    }
  };
  const target = { environmentId, input: { tier: DICTATION_MODEL_KEY } };
  const totalBytes = model.totalBytes ?? DICTATION_MODEL_BYTES;

  return (
    <div className="space-y-2">
      {model.phase === "downloading" ? (
        <>
          <div
            role="progressbar"
            aria-label="Speech model download"
            aria-valuemin={0}
            aria-valuemax={totalBytes}
            aria-valuenow={model.downloadedBytes}
            className="h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full origin-left bg-primary transition-transform duration-100 ease-linear"
              style={{ transform: `scaleX(${Math.min(1, model.downloadedBytes / totalBytes)})` }}
            />
          </div>
          <p className="tabular-nums">
            Downloading {megabytes(model.downloadedBytes)} of {megabytes(totalBytes)}.
          </p>
        </>
      ) : model.phase === "ready" ? (
        <p>Speech model downloaded ({megabytes(totalBytes)}). Works offline.</p>
      ) : model.phase === "failed" ? (
        <p>{model.message ?? "The speech model didn't download."}</p>
      ) : (
        <p>
          The speech model isn't downloaded yet. It downloads (about {megabytes(totalBytes)}) the
          first time you dictate.
        </p>
      )}
      {error ? <p className="text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        {model.phase === "downloading" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void run(() => cancel(target))}
          >
            Cancel
          </Button>
        ) : model.phase === "ready" ? (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => {
              closeDictationModel();
              void run(() => remove({ environmentId, input: { kind: "dictation" } }));
            }}
          >
            Remove speech model
          </Button>
        ) : (
          <Button
            type="button"
            size="xs"
            variant="outline"
            onClick={() => void run(() => download(target))}
          >
            {model.phase === "failed" ? "Try again" : "Download now"}
          </Button>
        )}
      </div>
    </div>
  );
}
