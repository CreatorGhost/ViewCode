import type { ScopedThreadRef } from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useCallback } from "react";

import { useComposerDraftStore } from "../../composerDraftStore";
import { useNewThreadHandler } from "../../hooks/useHandleNewThread";
import { readThreadShell } from "../../state/entities";
import { quoteForComposer } from "./selectionQuote";

/** Opens a new thread in the source thread's project with the selection quoted in its draft. */
export function useAskInNewChat(source: ScopedThreadRef | null) {
  const handleNewThread = useNewThreadHandler();
  return useCallback(
    async (quotedText: string) => {
      const shell = source ? readThreadShell(source) : null;
      if (!source || !shell) return;
      const created = await handleNewThread(scopeProjectRef(source.environmentId, shell.projectId));
      if (!created) return;
      useComposerDraftStore.getState().setPrompt(created.draftId, quoteForComposer(quotedText));
    },
    [handleNewThread, source],
  );
}
