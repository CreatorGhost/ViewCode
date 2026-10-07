import { scopedThreadKey, scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { ResolvedKeybindingsConfig } from "@t3tools/contracts";
import { useEffect, useMemo } from "react";

import { resolveShortcutCommand } from "../../keybindings";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { selectSidechatDock, useSidechatDockStore } from "../../sidechatDockStore";
import { useSplitPaneFocused } from "../../splitView/SplitPaneContext";
import { isSidechat } from "./sidechat.logic";
import { SidechatDock } from "./SidechatDock";

/**
 * Mounts the side chat dock beside a main thread and owns its keybinding.
 * A side chat never hosts another one, and drafts have no thread to ask about.
 * In split view only the focused pane answers the shortcut.
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
  const paneFocused = useSplitPaneFocused();

  useEffect(() => {
    if (parentRef === null || !paneFocused) return;
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
  }, [keybindings, paneFocused, parentRef]);

  if (!eligible || !open || parentRef === null) return null;
  // Keyed by parent so a draft or model pick never carries over to another thread's dock.
  return (
    <SidechatDock
      key={scopedThreadKey(parentRef)}
      parent={thread}
      markdownCwd={props.markdownCwd}
    />
  );
}
