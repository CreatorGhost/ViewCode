import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { type ReactElement } from "react";

import { useViewCodeThreadShells as useThreadShells } from "../../state/viewcodeThreadShells";
import { composerFloatingLayerProps } from "../chat/composerEventScope";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { agentStopState } from "./agentStop.logic";
import { useAgentControlActions } from "./useAgentControlActions";

/**
 * The composer's Stop button. When other agents in this thread's agent tree
 * are running it opens a choice: stop only this agent, or stop (and pause)
 * the whole tree. Otherwise it stops this thread directly, as before.
 * `render` draws the button; it gets `onClick` only in the direct case.
 */
export function AgentStopButton(props: {
  threadRef?: ScopedThreadRef | null | undefined;
  disabled?: boolean | undefined;
  tooltip?: string | undefined;
  onStopThis: () => void;
  render: (buttonProps: { readonly onClick?: () => void }) => ReactElement;
}) {
  const { onStopThis, render } = props;
  const params = useParams({ strict: false });
  const threads = useThreadShells();
  const routeRef =
    params.environmentId && params.threadId
      ? scopeThreadRef(EnvironmentId.make(params.environmentId), ThreadId.make(params.threadId))
      : null;
  const { ref, othersRunning } = agentStopState(threads, props.threadRef, routeRef);
  const { stop } = useAgentControlActions();
  const withTooltip = (trigger: ReactElement) =>
    props.tooltip ? (
      <Tooltip>
        <TooltipTrigger render={trigger} />
        <TooltipPopup>{props.tooltip}</TooltipPopup>
      </Tooltip>
    ) : (
      trigger
    );

  if (props.disabled) return withTooltip(render({}));
  if (ref === null || othersRunning.length === 0)
    return withTooltip(render({ onClick: onStopThis }));

  return (
    <Menu>
      {withTooltip(<MenuTrigger render={render({})} />)}
      <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
        <MenuItem onClick={onStopThis}>Stop this agent</MenuItem>
        <MenuItem onClick={() => void stop(ref, "tree")}>
          Stop all agents ({othersRunning.length + 1} running)
        </MenuItem>
        <MenuSeparator />
        <MenuGroup>
          <MenuGroupLabel>Also running</MenuGroupLabel>
          {othersRunning.map((entry) => (
            <MenuItem key={entry.thread.id} disabled>
              {entry.thread.title}
            </MenuItem>
          ))}
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}
