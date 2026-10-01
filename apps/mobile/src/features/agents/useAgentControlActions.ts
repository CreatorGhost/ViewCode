import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { AgentControlScope, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo } from "react";
import { Alert } from "react-native";

import { agentControlEnvironment } from "../../state/agentControl";
import { useAtomCommand } from "../../state/use-atom-command";
import { AGENT_MENU_EVENT, type AgentMenuEvent } from "./agentMenus";

type AgentRef = { readonly environmentId: EnvironmentId; readonly id: ThreadId };

function reportFailure<A, E>(result: AtomCommandResult<A, E>, title: string): boolean {
  if (result._tag !== "Failure") return true;
  if (isAtomCommandInterrupted(result)) return false;
  const error = squashAtomCommandFailure(result);
  Alert.alert(title, error instanceof Error ? error.message : "An error occurred.");
  return false;
}

/**
 * Stop, Resume and Discard for ViewCode agents over the same `agents.*` RPCs
 * the web uses. `tree` acts on the whole agent tree the thread belongs to.
 * Discard asks first: it drops agent messages nobody has read yet.
 */
export function useAgentControlActions() {
  const stopCommand = useAtomCommand(agentControlEnvironment.stop, { reportFailure: false });
  const resumeCommand = useAtomCommand(agentControlEnvironment.resume, { reportFailure: false });
  const discardCommand = useAtomCommand(agentControlEnvironment.discard, {
    reportFailure: false,
  });

  const stop = useCallback(
    async (ref: AgentRef, scope: AgentControlScope) =>
      reportFailure(
        await stopCommand({
          environmentId: ref.environmentId,
          input: { threadId: ref.id, scope },
        }),
        "Could not stop the agents",
      ),
    [stopCommand],
  );
  const resume = useCallback(
    async (ref: AgentRef, scope: AgentControlScope) =>
      reportFailure(
        await resumeCommand({
          environmentId: ref.environmentId,
          input: { threadId: ref.id, scope },
        }),
        "Could not resume",
      ),
    [resumeCommand],
  );
  const confirmDiscard = useCallback(
    (ref: AgentRef, scope: AgentControlScope) =>
      Alert.alert(
        scope === "tree" ? "Discard held agent messages?" : "Discard held messages?",
        scope === "tree"
          ? "Messages and replies waiting for these agents are dropped, and stopped agents stay idle."
          : "Messages and replies waiting for this agent are dropped, and it stays idle.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () =>
              void discardCommand({
                environmentId: ref.environmentId,
                input: { threadId: ref.id, scope },
              }).then((result) => reportFailure(result, "Could not discard the held messages")),
          },
        ],
      ),
    [discardCommand],
  );

  /** Runs an `agents:*` menu event against `ref`. */
  const runMenuEvent = useCallback(
    (ref: AgentRef, event: AgentMenuEvent) => {
      switch (event) {
        case AGENT_MENU_EVENT.stop:
          return void stop(ref, "thread");
        case AGENT_MENU_EVENT.resume:
          return void resume(ref, "thread");
        case AGENT_MENU_EVENT.discard:
          return confirmDiscard(ref, "thread");
        case AGENT_MENU_EVENT.stopAll:
          return void stop(ref, "tree");
        case AGENT_MENU_EVENT.resumeAll:
          return void resume(ref, "tree");
        case AGENT_MENU_EVENT.discardAll:
          return confirmDiscard(ref, "tree");
      }
    },
    [confirmDiscard, resume, stop],
  );

  return useMemo(
    () => ({ stop, resume, confirmDiscard, runMenuEvent }),
    [confirmDiscard, resume, runMenuEvent, stop],
  );
}
