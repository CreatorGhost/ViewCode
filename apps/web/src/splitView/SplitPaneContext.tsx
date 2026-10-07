import { createContext, use } from "react";

/**
 * Provided by each split pane. ChatView's window-level listeners (find,
 * shortcuts, paste-to-focus, autofocus) are per instance, so with two panes
 * mounted only the focused one may act. Outside a split there is no provider
 * and the answer is always yes.
 */
export const SplitPaneContext = createContext<{
  readonly focused: boolean;
  readonly onSwap: () => void;
  readonly onClose: () => void;
} | null>(null);

export function useSplitPaneFocused(): boolean {
  return use(SplitPaneContext)?.focused ?? true;
}

/** The pane's swap/close actions, or null outside a split. The pane header renders them. */
export function useSplitPaneActions(): { onSwap: () => void; onClose: () => void } | null {
  return use(SplitPaneContext);
}
