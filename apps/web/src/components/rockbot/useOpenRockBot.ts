import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { rockBotEnvironment } from "../../state/rockbot";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Opens the environment's latest RockBot chat in the chat view, creating one on first
 * use; `newChat` starts a fresh chat instead.
 */
export function useOpenRockBot(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const open = useAtomCommand(rockBotEnvironment.open, "Could not open RockBot");
  return async (options: { readonly newChat?: boolean } = {}) => {
    if (environmentId === null) return;
    const result = await open({
      environmentId,
      input: { creationSource: "web", ...(options.newChat ? { newChat: true } : {}) },
    });
    if (result._tag !== "Success") return;
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };
}
