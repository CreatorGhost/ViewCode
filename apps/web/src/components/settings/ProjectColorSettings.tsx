import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts";

import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

/** Settings -> Appearance -> Project colour: the active project's tint and the composer glow. */
export function ProjectColorSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsSection id="appearance-project-colour" title="Project colour">
      <SettingsRow
        {...searchableSetting("project-color-tint")}
        description="While the rail shows one project, the sidebar and the composer glow take its colour. Off, they keep the theme accent."
        resetAction={
          settings.projectColorTint !== DEFAULT_CLIENT_SETTINGS.projectColorTint ? (
            <SettingResetButton
              label="colour the app with the active project"
              onClick={() =>
                updateSettings({ projectColorTint: DEFAULT_CLIENT_SETTINGS.projectColorTint })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.projectColorTint}
            onCheckedChange={(checked) => updateSettings({ projectColorTint: Boolean(checked) })}
            aria-label="Colour the app with the active project"
          />
        }
      />
      <SettingsRow
        {...searchableSetting("composer-glow")}
        description="A soft glow around the composer while the agent works."
        resetAction={
          settings.composerGlow !== DEFAULT_CLIENT_SETTINGS.composerGlow ? (
            <SettingResetButton
              label="composer glow"
              onClick={() => updateSettings({ composerGlow: DEFAULT_CLIENT_SETTINGS.composerGlow })}
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.composerGlow}
            onCheckedChange={(checked) => updateSettings({ composerGlow: Boolean(checked) })}
            aria-label="Composer glow"
          />
        }
      />
    </SettingsSection>
  );
}
