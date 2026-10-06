import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { isSidechat } from "./sidechat.logic";
import { SidechatDock } from "./SidechatDock";

/**
 * Mounts the side chat dock beside a main thread and owns its keybinding.
 * A side chat never hosts another one, and drafts have no thread to ask about.
 */
export function SidechatHost(props: {
  thread: EnvironmentThreadShell | null;
  keybindings: ResolvedKeybindingsConfig;
  markdownCwd: string | undefined;
}) {
  const { thread, keybindings } = props;
  const eligible = thread !== null && !isSidechat(thread);
  const environmentId = eligible ? thread.environmentId : null;
  const threadId = eligible ? thread.id : null;
  const parentRef = useMemo(
    () =>
      environmentId !== null && threadId !== null ? scopeThreadRef(environmentId, threadId) : null,
    [environmentId, threadId],
  );
  const open = useSidechatDockStore(
    (state) => selectSidechatDock(state.byParentKey, parentRef).open,
  );

  useEffect(() => {
    if (parentRef === null) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const command = resolveShortcutCommand(event, keybindings, {
        context: { terminalFocus: getTerminalFocusOwner() !== null, terminalOpen: false },
      });
      if (command !== "sidechat.toggle") return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      useSidechatDockStore.getState().toggle(parentRef);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [keybindings, parentRef]);

  if (!eligible || !open) return null;
  return <SidechatDock parent={thread} markdownCwd={props.markdownCwd} />;
}
