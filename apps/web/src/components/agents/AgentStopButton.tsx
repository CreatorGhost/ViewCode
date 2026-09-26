import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useParams } from "@tanstack/react-router";
import { type ReactElement, useMemo } from "react";

import { useThreadShells } from "../../state/entities";
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
import { collectAgentTree } from "./childAgents.logic";
import { useAgentControlActions } from "./useAgentControlActions";

/**
 * The composer's Stop button. When other agents in this thread's agent tree
 * are running it opens a choice: stop only this agent, or stop (and pause)
 * the whole tree. Otherwise it stops this thread directly, as before.
 * `render` draws the button; it gets `onClick` only in the direct case.
 */
export function AgentStopButton(props: {
  onStopThis: () => void;
  render: (buttonProps: { readonly onClick?: () => void }) => ReactElement;
}) {
  const { onStopThis, render } = props;
  const params = useParams({ strict: false });
  const threads = useThreadShells();
  const ref = useMemo(
    () =>
      params.environmentId && params.threadId
        ? scopeThreadRef(EnvironmentId.make(params.environmentId), ThreadId.make(params.threadId))
        : null,
    [params.environmentId, params.threadId],
  );
  const othersRunning = useMemo(
    () =>
      ref === null
        ? []
        : collectAgentTree(threads, ref).filter(
            (entry) => entry.running && entry.thread.id !== ref.threadId,
          ),
    [ref, threads],
  );
  const { stop } = useAgentControlActions();

  if (ref === null || othersRunning.length === 0) return render({ onClick: onStopThis });

  return (
    <Menu>
      <MenuTrigger render={render({})} />
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
