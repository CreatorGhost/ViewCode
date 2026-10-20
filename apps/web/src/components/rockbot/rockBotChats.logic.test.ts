import { describe, expect, it } from "vite-plus/test";

import { rockBotChatsForRoute } from "./rockBotChats.logic";

const thread = (
  id: string,
  updatedAt: string,
  extra: { kind?: string | null; archivedAt?: string | null; environmentId?: string } = {},
) => ({
  environmentId: "local",
  id,
  kind: null,
  archivedAt: null,
  updatedAt,
  ...extra,
});

describe("rockBotChatsForRoute", () => {
  const threads = [
    thread("work", "2026-10-20T13:00:00Z"),
    thread("rockbot:old", "2026-10-19T10:00:00Z", { kind: "orchestrator" }),
    thread("rockbot", "2026-10-20T12:00:00Z", { kind: "orchestrator" }),
    thread("rockbot:gone", "2026-10-20T11:00:00Z", {
      kind: "orchestrator",
      archivedAt: "2026-10-20T11:30:00Z",
    }),
    thread("rockbot:remote", "2026-10-20T12:30:00Z", {
      kind: "orchestrator",
      environmentId: "remote",
    }),
  ];

  it("lists this environment's live RockBot chats, newest first, while one is open", () => {
    expect(
      rockBotChatsForRoute(threads, { environmentId: "local", threadId: "rockbot:old" })?.map(
        (chat) => chat.id,
      ),
    ).toEqual(["rockbot", "rockbot:old"]);
  });

  it("leaves the project tree alone on any other thread or page", () => {
    expect(rockBotChatsForRoute(threads, { environmentId: "local", threadId: "work" })).toBeNull();
    expect(rockBotChatsForRoute(threads, null)).toBeNull();
  });
});
