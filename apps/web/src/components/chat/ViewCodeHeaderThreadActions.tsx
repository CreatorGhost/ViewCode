import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { TerminalIcon } from "lucide-react";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ReviewHeaderButton } from "./ReviewHeaderButton";
import { SidechatHeaderButton } from "./SidechatHeaderButton";

export function ViewCodeHeaderThreadActions(props: {
  threadRef: ScopedThreadRef;
  isServerThread: boolean;
  isSidechat: boolean;
  keybindings: ResolvedKeybindingsConfig;
  terminalAvailable: boolean;
  terminalOpen: boolean;
  terminalShortcutLabel?: string | null | undefined;
  terminalUnavailableReason?: string | undefined;
  onToggleTerminal: () => void;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}) {
  const threadActionsDisabled = !props.isServerThread || props.disabled === true;
  const terminalDisabled = !props.terminalAvailable;
  const draftReason = "Send a message to start this thread before";
  return (
    <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Button
            variant="chip"
            size="icon-chip"
            aria-label="Toggle terminal drawer"
            aria-pressed={props.terminalOpen}
            data-pressed={props.terminalOpen || undefined}
            disabled={terminalDisabled}
            onClick={() => {
              if (terminalDisabled) return;
              props.onToggleTerminal();
            }}
          >
            <TerminalIcon />
          </Button>
        </TooltipTrigger>
        <TooltipPopup>
          {terminalDisabled
            ? (props.terminalUnavailableReason ?? "Terminal drawer is unavailable")
            : `Toggle terminal drawer${props.terminalShortcutLabel ? ` (${props.terminalShortcutLabel})` : ""}`}
        </TooltipPopup>
      </Tooltip>
      {props.isSidechat ? null : (
        <SidechatHeaderButton
          environmentId={props.threadRef.environmentId}
          threadId={props.threadRef.threadId}
          keybindings={props.keybindings}
          disabled={threadActionsDisabled}
          disabledReason={
            !props.isServerThread ? `${draftReason} opening a side chat.` : props.disabledReason
          }
        />
      )}
      <ReviewHeaderButton
        environmentId={props.threadRef.environmentId}
        threadId={props.threadRef.threadId}
        compact={false}
        disabled={threadActionsDisabled}
        disabledReason={
          !props.isServerThread ? `${draftReason} viewing review findings.` : props.disabledReason
        }
      />
    </div>
  );
}
