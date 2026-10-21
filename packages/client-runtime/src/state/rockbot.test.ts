import { describe, expect, it } from "vite-plus/test";

import { rockBotChatsIn } from "./rockbot.ts";

const thread = (
  id: string,
  extra: {
    kind?: string | null;
    archivedAt?: string | null;
    updatedAt?: string;
  } = {},
) => ({
  environmentId: "local",
  id,
  kind: null,
  archivedAt: null,
  updatedAt: "2026-10-20T10:00:00Z",
  ...extra,
});
describe("rockBotChatsIn", () => {
  it("lists one environment's live RockBot chats, newest first", () => {
    expect(
      rockBotChatsIn(
        [
          thread("rockbot", { kind: "orchestrator", updatedAt: "2026-10-20T09:00:00Z" }),
          thread("rockbot:2", { kind: "orchestrator", updatedAt: "2026-10-20T12:00:00Z" }),
          thread("rockbot:gone", { kind: "orchestrator", archivedAt: "2026-10-20T13:00:00Z" }),
          thread("work"),
        ],
        "local",
      ).map((chat) => chat.id),
    ).toEqual(["rockbot:2", "rockbot"]);
  });
});
