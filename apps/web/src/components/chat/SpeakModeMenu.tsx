import type { EnvironmentId } from "@t3tools/contracts";
import { AudioLinesIcon, VolumeOffIcon } from "lucide-react";

import { useSpeakMode } from "~/hooks/useSpeakMode";
import { isReadAloudSupported } from "~/lib/readAloudPlayer";
import { SPEAK_MODE_OPTIONS, speakModeLabel } from "~/lib/speakMode.logic";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Speak mode from the chat header: Off, Summary or Full reply, for the thread's environment. */
export function SpeakModeMenu({ environmentId }: { environmentId: EnvironmentId }) {
  const { mode, setMode } = useSpeakMode(environmentId);
  if (!isReadAloudSupported()) return null;
  const label = `Speak replies: ${speakModeLabel(mode)}`;
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <Button
                  type="button"
                  variant="header"
                  size="icon-header"
                  aria-label={label}
                  data-speak-mode={mode}
                />
              }
            />
          }
        >
          {mode === "off" ? (
            <VolumeOffIcon aria-hidden="true" />
          ) : (
            <AudioLinesIcon aria-hidden="true" />
          )}
        </TooltipTrigger>
        <TooltipPopup side="bottom">{label}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="end">
        <MenuGroup>
          <MenuGroupLabel>Speak replies when a turn finishes</MenuGroupLabel>
          <MenuRadioGroup
            value={mode}
            onValueChange={(value) => {
              const next = SPEAK_MODE_OPTIONS.find((option) => option.mode === value);
              if (next !== undefined) setMode(next.mode);
            }}
          >
            {SPEAK_MODE_OPTIONS.map((option) => (
              <MenuRadioItem key={option.mode} value={option.mode}>
                <span className="flex items-center justify-between gap-3">
                  {option.label}
                  <MenuRadioItemIndicator />
                </span>
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
