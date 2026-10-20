import { describe, expect, it } from "vite-plus/test";

import { holdsOnlyRockBot, rockBotChatsIn } from "./rockbot.ts";

const thread = (
  id: string,
  extra: {
    kind?: string | null;
    projectId?: string;
    archivedAt?: string | null;
    updatedAt?: string;
  } = {},
) => ({
  environmentId: "local",
  id,
  projectId: "scratch",
  kind: null,
  archivedAt: null,
  updatedAt: "2026-10-20T10:00:00Z",
  ...extra,
});
const scratch = new Set(["local:scratch"]);
const kindOf = (value: { kind?: string | null }) => value.kind;

describe("holdsOnlyRockBot", () => {
  it("claims the scratch folder while RockBot chats are all it holds", () => {
    expect(
      holdsOnlyRockBot(
        scratch,
        [
          thread("rockbot", { kind: "orchestrator" }),
          thread("old", { archivedAt: "2026-10-19T10:00:00Z" }),
          thread("work", { projectId: "viewcode" }),
        ],
        kindOf,
      ),
    ).toBe(true);
  });

  it("gives it back once the user has a live thread there, and never claims an empty one", () => {
    expect(
      holdsOnlyRockBot(
        scratch,
        [thread("rockbot", { kind: "orchestrator" }), thread("mine")],
        kindOf,
      ),
    ).toBe(false);
    expect(holdsOnlyRockBot(scratch, [thread("work", { projectId: "viewcode" })], kindOf)).toBe(
      false,
    );
  });
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
