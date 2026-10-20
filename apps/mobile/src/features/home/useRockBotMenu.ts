import { useAtomValue } from "@effect/atom-react";
import { rockBotChatsIn } from "@t3tools/client-runtime/state/rockbot";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigation } from "@react-navigation/native";

import { rockBotEnvironment } from "../../state/rockbot";
import { useAtomCommand } from "../../state/use-atom-command";

/** Recent chats the Home menu lists; the web sidebar lists every one. */
export const ROCKBOT_MENU_CHAT_LIMIT = 8;

/** RockBot's entry on Home: its recent chats, and opening one or starting a new one. */
export interface RockBotMenu {
  readonly chats: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  /** Opens the latest chat, creating the first one. */
  readonly openLatest: () => void;
  readonly startNewChat: () => void;
  readonly openChat: (threadId: string) => void;
}

/**
 * Undefined while there is no environment or the user may not operate its threads,
 * so the header leaves RockBot out.
 */
export function useRockBotMenu(
  environmentId: EnvironmentId | null,
  threads: ReadonlyArray<{
    readonly environmentId: string;
    readonly id: string;
    readonly title: string;
    readonly kind?: string | null | undefined;
    readonly archivedAt: string | null;
    readonly updatedAt: string;
  }>,
): RockBotMenu | undefined {
  const navigation = useNavigation();
  const open = useAtomCommand(rockBotEnvironment.open, "Could not open RockBot");
  const canOpen = useAtomValue(rockBotEnvironment.open.permissionAtom(environmentId));
  if (environmentId === null || !canOpen) return undefined;
  const openChat = (threadId: string) =>
    navigation.navigate("Thread", { environmentId: String(environmentId), threadId });
  const openFromServer = (newChat: boolean) => {
    void open({
      environmentId,
      input: { creationSource: "mobile", ...(newChat ? { newChat: true } : {}) },
    }).then((result) => {
      if (result._tag === "Success") openChat(String(result.value.threadId));
    });
  };
  return {
    chats: rockBotChatsIn(threads, environmentId)
      .slice(0, ROCKBOT_MENU_CHAT_LIMIT)
      .map((chat) => ({ id: chat.id, title: chat.title })),
    openLatest: () => openFromServer(false),
    startNewChat: () => openFromServer(true),
    openChat,
  };
}
