import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { readThreadShell, waitForThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import {
  makeEnsureViewCodePanelThread,
  type EnsureViewCodePanelThreadInput,
} from "./ensureViewCodePanelThread";

export function useEnsureViewCodePanelThread(input: EnsureViewCodePanelThreadInput) {
  const create = useOrchestrationCommand(threadEnvironment.create, { reportFailure: false });
  const createStable = useStableCallback(create);
  const [ensure] = useState(() =>
    makeEnsureViewCodePanelThread({
      create: createStable,
      readThread: readThreadShell,
      waitForThread: waitForThreadShell,
      canOperate: (environmentId) =>
        readEnvironmentScope(environmentId, AuthOrchestrationOperateScope),
      now: () => new Date().toISOString(),
    }),
  );
  const [isEnsuringPanelThread, setIsEnsuringPanelThread] = useState(false);
  const ensurePanelThread = useStableCallback(async () => {
    setIsEnsuringPanelThread(true);
    try {
      return await ensure(input);
    } catch {
      toastManager.add({
        type: "error",
        title: "Could not open thread panel",
        description: "The thread could not be saved. Your draft is still available. Try again.",
      });
      return null;
    } finally {
      setIsEnsuringPanelThread(false);
    }
  });
  return { ensurePanelThread, isEnsuringPanelThread };
}
