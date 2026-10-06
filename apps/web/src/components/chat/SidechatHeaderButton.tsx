import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { MessageSquareMoreIcon } from "lucide-react";
import { useMemo } from "react";

import { shortcutLabelForCommand } from "../../keybindings";
import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Header toggle for the side chat dock. Shown on server threads only. */
export function SidechatHeaderButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  keybindings: ResolvedKeybindingsConfig;
}) {
  const parentRef = useMemo(
    () => scopeThreadRef(props.environmentId, props.threadId),
    [props.environmentId, props.threadId],
  );
  const open = useSidechatDockStore(
    (state) => selectSidechatDock(state.byParentKey, parentRef).open,
  );
  const shortcut = shortcutLabelForCommand(props.keybindings, "sidechat.toggle", {
    context: { terminalFocus: false, terminalOpen: false },
  });
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost-muted"
            size="icon-xs"
            aria-label="Side chat"
            aria-pressed={open}
            onClick={() => useSidechatDockStore.getState().toggle(parentRef)}
          />
        }
      >
        <MessageSquareMoreIcon />
      </TooltipTrigger>
      <TooltipPopup>{shortcut ? `Side chat (${shortcut})` : "Side chat"}</TooltipPopup>
    </Tooltip>
  );
}
