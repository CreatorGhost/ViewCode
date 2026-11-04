import type { ScopedThreadRef } from "@t3tools/contracts";
import { useState } from "react";

import { agentControlEnvironment } from "../../state/agentControl";
import { useAtomCommand } from "../../state/use-atom-command";

/** Called before loading returns, so a thread becoming ready keeps the hook order. */
export function useThreadUsageResume(threadRef: ScopedThreadRef | null) {
  const cancel = useAtomCommand(agentControlEnvironment.cancelUsageResume);
  const resume = useAtomCommand(agentControlEnvironment.resumeUsageNow);
  const [busy, setBusy] = useState(false);
  const run = (command: typeof cancel) => async () => {
    if (threadRef === null) return;
    setBusy(true);
    try {
      return await command({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    } finally {
      setBusy(false);
    }
  };
  return { busy, onCancel: run(cancel), onResumeNow: run(resume) };
}
