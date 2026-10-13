import type { ProviderInteractionMode } from "@t3tools/contracts";
import { BugIcon, PaperclipIcon, PencilRulerIcon, PlusIcon } from "lucide-react";
import { memo } from "react";

import { Menu, MenuCheckboxItem, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";

/**
 * The leading "+" capsule of the composer toolbar: one place for the extras
 * that used to sit as loose buttons (attach files, plan mode). Dropping files
 * and pasting still work without it; this only consolidates the entry points.
 */
export const ComposerExtrasMenu = memo(function ComposerExtrasMenu(props: {
  showAttach: boolean;
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  debugMode: boolean;
  onAttach: () => void;
  onToggleInteractionMode: () => void;
  onDebugModeChange: (debugMode: boolean) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  return (
    <Menu>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  data-composer-extras-trigger="true"
                  className="shrink-0 px-1.5!"
                  aria-label="Add to message"
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={PlusIcon} opticalSize="large" />
        </TooltipTrigger>
        <TooltipPopup side="top">Attach files, plan and debug mode</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.showAttach ? (
          <MenuItem onClick={props.onAttach}>
            <PaperclipIcon />
            Attach files
          </MenuItem>
        ) : null}
        {props.showInteractionModeToggle ? (
          <MenuCheckboxItem
            checked={props.interactionMode === "plan"}
            onCheckedChange={props.onToggleInteractionMode}
          >
            <span className="inline-flex items-center gap-2">
              <PencilRulerIcon className="size-4" />
              Plan mode
            </span>
          </MenuCheckboxItem>
        ) : null}
        <MenuCheckboxItem checked={props.debugMode} onCheckedChange={props.onDebugModeChange}>
          <span className="inline-flex items-center gap-2">
            <BugIcon className="size-4" />
            Debug mode
          </span>
        </MenuCheckboxItem>
      </MenuPopup>
    </Menu>
  );
});
