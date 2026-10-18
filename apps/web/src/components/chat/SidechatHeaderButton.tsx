import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ResolvedKeybindingsConfig, ThreadId } from "@t3tools/contracts";
import { MessageSquareMoreIcon } from "lucide-react";

import { shortcutLabelForCommand } from "../../keybindings";
import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Header toggle for the side chat dock. */
export function SidechatHeaderButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  keybindings: ResolvedKeybindingsConfig;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}) {
  const parentRef = scopeThreadRef(props.environmentId, props.threadId);
  const open = useSidechatDockStore(
    (state) => selectSidechatDock(state.byParentKey, parentRef).open,
  );
  const shortcut = shortcutLabelForCommand(props.keybindings, "sidechat.toggle", {
    context: { terminalFocus: false, terminalOpen: false },
  });
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="flex shrink-0" />}>
        <Button
          variant="chip"
          size="icon-chip"
          aria-label="Side chat"
          aria-pressed={open}
          data-pressed={open || undefined}
          disabled={props.disabled}
          onClick={() => {
            if (props.disabled) return;
            useSidechatDockStore.getState().toggle(parentRef);
          }}
        >
          <MessageSquareMoreIcon />
        </Button>
      </TooltipTrigger>
      <TooltipPopup>
        {props.disabled
          ? (props.disabledReason ?? "Side chat is unavailable for this thread")
          : shortcut
            ? `Side chat (${shortcut})`
            : "Side chat"}
      </TooltipPopup>
    </Tooltip>
  );
}
