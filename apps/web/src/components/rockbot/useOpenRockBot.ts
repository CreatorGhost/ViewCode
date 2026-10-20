import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { rockBotEnvironment } from "../../state/rockbot";
import { useAtomCommand } from "../../state/use-atom-command";

/** Opens the environment's RockBot thread in the chat view, creating it on first use. */
export function useOpenRockBot(environmentId: EnvironmentId | null) {
  const navigate = useNavigate();
  const open = useAtomCommand(rockBotEnvironment.open, "Could not open RockBot");
  return async () => {
    if (environmentId === null) return;
    const result = await open({ environmentId, input: { creationSource: "web" } });
    if (result._tag !== "Success") return;
    await navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: result.value.threadId },
    });
  };
}
