import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";

import { rockBotEnvironment } from "../../state/rockbot";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * Opens the environment's RockBot thread, creating it on first use. Undefined
 * while there is no environment or the user may not operate its threads, so the
 * header leaves its button out.
 */
export function useOpenRockBot(environmentId: EnvironmentId | null): (() => void) | undefined {
  const navigation = useNavigation();
  const open = useAtomCommand(rockBotEnvironment.open, "Could not open RockBot");
  const canOpen = useAtomValue(rockBotEnvironment.open.permissionAtom(environmentId));
  if (environmentId === null || !canOpen) return undefined;
  return () => {
    void open({ environmentId, input: { creationSource: "mobile" } }).then((result) => {
      if (result._tag !== "Success") return;
      navigation.navigate("Thread", {
        environmentId: String(environmentId),
        threadId: String(result.value.threadId),
      });
    });
  };
}
