import type { ResolvedKeybindingsConfig, ScopedThreadRef } from "@t3tools/contracts";
import { SquareTerminalIcon } from "lucide-react";

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
  onOpenSidechat?: (() => void) | undefined;
  onOpenReview?: (() => void) | undefined;
  busy?: boolean | undefined;
  disabled?: boolean | undefined;
  disabledReason?: string | undefined;
}) {
  const threadActionsDisabled = props.disabled === true || props.busy === true;
  const disabledReason = props.busy ? "Preparing thread…" : props.disabledReason;
  const terminalDisabled = !props.terminalAvailable;
  const draftReason = "Send a message to start this thread before";
  return (
    <div
      data-header-actions-group
      className="flex shrink-0 items-center gap-2 [-webkit-app-region:no-drag]"
    >
      <Tooltip>
        <TooltipTrigger render={<span className="flex shrink-0" />}>
          <Button
            variant="header"
            size="icon-header"
            aria-label="Toggle terminal drawer"
            aria-pressed={props.terminalOpen}
            data-pressed={props.terminalOpen || undefined}
            disabled={terminalDisabled}
            onClick={() => {
              if (terminalDisabled) return;
              props.onToggleTerminal();
            }}
          >
            <SquareTerminalIcon />
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
          onToggle={props.onOpenSidechat}
          disabled={threadActionsDisabled || (!props.isServerThread && !props.onOpenSidechat)}
          disabledReason={
            disabledReason ??
            (!props.isServerThread ? `${draftReason} opening a side chat.` : undefined)
          }
        />
      )}
      <ReviewHeaderButton
        environmentId={props.threadRef.environmentId}
        threadId={props.threadRef.threadId}
        compact={false}
        onToggle={props.onOpenReview}
        disabled={threadActionsDisabled || (!props.isServerThread && !props.onOpenReview)}
        disabledReason={
          disabledReason ??
          (!props.isServerThread ? `${draftReason} viewing review findings.` : undefined)
        }
      />
    </div>
  );
}
