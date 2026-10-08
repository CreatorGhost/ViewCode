import { DEFAULT_CLIENT_SETTINGS, type ChatDensity, type ChatWidth } from "@t3tools/contracts";

import { CHAT_DENSITY_OPTIONS, CHAT_WIDTH_OPTIONS } from "../chat/appearance/chatAppearance";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

function labelFor<Value extends string>(
  options: ReadonlyArray<{ value: Value; label: string }>,
  value: Value,
): string {
  return options.find((option) => option.value === value)?.label ?? value;
}

/** Settings -> Appearance -> Chat: transcript density, column width, turn folding. */
export function ChatAppearanceSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();

  return (
    <SettingsSection id="appearance-chat" title="Chat">
      <SettingsRow
        {...searchableSetting("chat-density")}
        description="Space between messages and tool calls in the transcript."
        resetAction={
          settings.chatDensity !== DEFAULT_CLIENT_SETTINGS.chatDensity ? (
            <SettingResetButton
              label="chat density"
              onClick={() => updateSettings({ chatDensity: DEFAULT_CLIENT_SETTINGS.chatDensity })}
            />
          ) : null
        }
        control={
          <Select
            value={settings.chatDensity}
            onValueChange={(value) => {
              const option = CHAT_DENSITY_OPTIONS.find((candidate) => candidate.value === value);
              if (option) updateSettings({ chatDensity: option.value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Chat density">
              <SelectValue>
                {labelFor<ChatDensity>(CHAT_DENSITY_OPTIONS, settings.chatDensity)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {CHAT_DENSITY_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("chat-width")}
        description="Maximum width of the conversation and the composer."
        resetAction={
          settings.chatWidth !== DEFAULT_CLIENT_SETTINGS.chatWidth ? (
            <SettingResetButton
              label="chat width"
              onClick={() => updateSettings({ chatWidth: DEFAULT_CLIENT_SETTINGS.chatWidth })}
            />
          ) : null
        }
        control={
          <Select
            value={settings.chatWidth}
            onValueChange={(value) => {
              const option = CHAT_WIDTH_OPTIONS.find((candidate) => candidate.value === value);
              if (option) updateSettings({ chatWidth: option.value });
            }}
          >
            <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Chat width">
              <SelectValue>
                {labelFor<ChatWidth>(CHAT_WIDTH_OPTIONS, settings.chatWidth)}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {CHAT_WIDTH_OPTIONS.map((option) => (
                <SelectItem hideIndicator key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        {...searchableSetting("collapse-finished-turns")}
        description="Fold the tool calls of finished turns into one summary row. The running turn stays open."
        resetAction={
          settings.collapseFinishedTurns !== DEFAULT_CLIENT_SETTINGS.collapseFinishedTurns ? (
            <SettingResetButton
              label="collapse finished turns"
              onClick={() =>
                updateSettings({
                  collapseFinishedTurns: DEFAULT_CLIENT_SETTINGS.collapseFinishedTurns,
                })
              }
            />
          ) : null
        }
        control={
          <Switch
            checked={settings.collapseFinishedTurns}
            onCheckedChange={(checked) =>
              updateSettings({ collapseFinishedTurns: Boolean(checked) })
            }
            aria-label="Collapse finished turns"
          />
        }
      />
    </SettingsSection>
  );
}
