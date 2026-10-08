import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { openSideChat } from "../../sidechatDockStore";
import { useThreadShell } from "../../state/entities";
import { quoteForComposer } from "./selectionQuote";
import { isSidechat } from "./sidechat.logic";

/**
 * Opens the side chat beside the source thread with the selection quoted in its composer.
 * Null where SidechatHost would show no dock: drafts and side chats themselves.
 */
export function useAskInSideChat(source: ScopedThreadRef | null) {
  const shell = useThreadShell(source);
  const eligible = shell !== null && !isSidechat(shell);
  return useMemo(
    () =>
      eligible && source
        ? (quotedText: string) => openSideChat(source, quoteForComposer(quotedText))
        : null,
    [eligible, source],
  );
}
