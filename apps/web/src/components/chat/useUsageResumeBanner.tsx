import type { OrchestrationLatestTurn } from "@t3tools/client-runtime/viewcodeThread";
import { deriveUsageResumeNotice } from "@t3tools/client-runtime/usage-resume";
import type { OrchestrationThreadActivity, ScopedThreadRef } from "@t3tools/contracts";
import { AlarmClockIcon } from "lucide-react";
import { useState } from "react";
import { useNowMinute } from "../../hooks/useNowMinute";

import { agentControlEnvironment } from "../../state/agentControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * "Out of usage · resumes automatically at 6:01 AM" with Cancel and Resume
 * now, from the server's usage-resume activity. Null when the thread is not
 * stopped on a usage limit.
 */
export function useUsageResumeBanner(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly session: { readonly status: string } | null;
  readonly latestTurn: OrchestrationLatestTurn | null;
}): ComposerBannerStackItem | null {
  const { threadRef, activities, session, latestTurn } = input;
  const cancel = useAtomCommand(agentControlEnvironment.cancelUsageResume);
  const resumeNow = useAtomCommand(agentControlEnvironment.resumeUsageNow);
  const [busy, setBusy] = useState(false);
  const nowMinute = useNowMinute();

  const notice = (() =>
    threadRef === null
      ? null
      : deriveUsageResumeNotice({
          activities,
          session,
          latestTurn,
          nowMs: Date.parse(`${nowMinute}:00.000Z`),
        }))();

  const run = async (command: typeof cancel) => {
    if (threadRef === null) return;
    setBusy(true);
    try {
      await command({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      });
    } finally {
      setBusy(false);
    }
  };

  return (() => {
    if (notice === null || threadRef === null) return null;
    return {
      id: `usage-resume:${threadRef.threadId}`,
      variant: "warning",
      icon: <AlarmClockIcon />,
      title: notice.text,
      actions: (
        <>
          {notice.canCancel ? (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run(cancel)}>
              Cancel
            </Button>
          ) : null}
          <Button size="xs" variant="ghost" disabled={busy} onClick={() => void run(resumeNow)}>
            Resume now
          </Button>
        </>
      ),
    };
  })();
}
