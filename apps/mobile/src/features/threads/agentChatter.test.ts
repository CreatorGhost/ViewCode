import { MessageId } from "@t3tools/contracts";
import { formatAgentMessage } from "@t3tools/shared/agentMessages";
import { describe, expect, it } from "vite-plus/test";

import type { ThreadFeedEntry } from "../../lib/threadActivity";
import {
  findLastUserMessageIndex,
  groupAgentChatter,
  isAgentMessageEntry,
  type AgentChatterHeaderEntry,
} from "./agentChatter";

const CREATED_AT = "2026-10-01T10:00:00.000Z";

function message(id: string, role: "user" | "assistant" | "reasoning", text: string) {
  return {
    type: "message",
    id,
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role,
      text,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      turnId: null,
      streaming: false,
    },
  } satisfies ThreadFeedEntry;
}

const incoming = (id: string) =>
  message(
    id,
    "user",
    formatAgentMessage({
      messageId: `m-${id}`,
      fromThreadId: "child",
      fromName: "Child",
      replyExpected: false,
      inReplyTo: null,
      body: "Done.",
    }),
  );

const outgoing = (id: string, kind: "message" | "spawn" = "message"): ThreadFeedEntry => ({
  type: "agent-message",
  id,
  createdAt: CREATED_AT,
  turnId: null,
  sent: {
    messageId: `m-${id}`,
    toThreadId: "child",
    toName: "Child",
    body: "Do it.",
    replyExpected: true,
    inReplyTo: null,
    kind,
    delivery: "started",
  },
});

const work = (id: string): ThreadFeedEntry => ({
  type: "work-toggle",
  id,
  createdAt: CREATED_AT,
  turnId: null,
  groupId: `group-${id}`,
  hiddenCount: 2,
  expanded: false,
  summary: "Ran 2 commands",
  summaryKind: "command",
  hasFailure: false,
  live: false,
  shimmer: false,
});

const thinking: ThreadFeedEntry = {
  type: "thinking",
  id: "live-activity-row",
  createdAt: CREATED_AT,
  turnId: null,
};

const ids = (result: ReturnType<typeof groupAgentChatter>) => result.entries.map((e) => e.id);
const header = (result: ReturnType<typeof groupAgentChatter>) =>
  result.entries.find((e): e is AgentChatterHeaderEntry => e.type === "agent-chatter");
const settled = { overrides: {}, working: false };

describe("agent message detection", () => {
  it("recognises outgoing entries and incoming envelopes, not spawns or plain user text", () => {
    expect(isAgentMessageEntry(outgoing("out"))).toBe(true);
    expect(isAgentMessageEntry(incoming("in"))).toBe(true);
    expect(isAgentMessageEntry(outgoing("spawn", "spawn"))).toBe(false);
    expect(isAgentMessageEntry(message("hi", "user", "hello"))).toBe(false);
    expect(isAgentMessageEntry(message("a", "assistant", "hello"))).toBe(false);
  });
});

describe("groupAgentChatter", () => {
  const run = [outgoing("a1"), work("w1"), incoming("a2"), work("w2"), outgoing("a3")];

  it("collapses a finished run, with work rows between messages, to one header", () => {
    const result = groupAgentChatter(
      [message("u", "user", "go"), ...run, message("done", "assistant", "All set")],
      settled,
    );
    expect(ids(result)).toEqual(["u", "agent-chatter:a1", "done"]);
    expect(header(result)).toMatchObject({
      groupId: "a1",
      messageCount: 3,
      live: false,
      expanded: false,
    });
    expect(result.memberIds.size).toBe(0);
  });

  it("opens a live run and lists every member in order, keeping trailing work and thinking outside", () => {
    const result = groupAgentChatter([...run, work("w3"), thinking], {
      overrides: {},
      working: true,
    });
    expect(ids(result)).toEqual([
      "agent-chatter:a1",
      "a1",
      "w1",
      "a2",
      "w2",
      "a3",
      "w3",
      "live-activity-row",
    ]);
    expect(header(result)).toMatchObject({ live: true, expanded: true });
    expect([...result.memberIds]).toEqual(["a1", "w1", "a2", "w2", "a3"]);
  });

  it("lets a user toggle win over the default either way", () => {
    const live = groupAgentChatter(run, { overrides: { a1: false }, working: true });
    expect(ids(live)).toEqual(["agent-chatter:a1"]);
    const finished = groupAgentChatter(run, { overrides: { a1: true }, working: false });
    expect(ids(finished)).toEqual(["agent-chatter:a1", "a1", "w1", "a2", "w2", "a3"]);
  });

  it("does not treat a run as live once the thread stops working", () => {
    expect(header(groupAgentChatter(run, settled))).toMatchObject({ live: false, expanded: false });
  });

  it("leaves a lone agent message ungrouped", () => {
    const entries = [message("u", "user", "go"), outgoing("a1"), work("w1")];
    const result = groupAgentChatter(entries, { overrides: {}, working: true });
    expect(result.entries).toBe(entries);
    expect(result.memberIds.size).toBe(0);
  });

  it("ends a run at a visible assistant message and starts a new one after it", () => {
    const result = groupAgentChatter(
      [
        outgoing("a1"),
        incoming("a2"),
        message("lead", "assistant", "Waiting."),
        outgoing("b1"),
        incoming("b2"),
      ],
      settled,
    );
    expect(ids(result)).toEqual(["agent-chatter:a1", "lead", "agent-chatter:b1"]);
  });

  it("is not live when a visible message follows the run", () => {
    const result = groupAgentChatter(
      [outgoing("a1"), incoming("a2"), message("lead", "assistant", "Waiting.")],
      { overrides: {}, working: true },
    );
    expect(header(result)).toMatchObject({ live: false, expanded: false });
  });

  it("keeps work after the last agent message outside a finished run", () => {
    const result = groupAgentChatter(
      [outgoing("a1"), incoming("a2"), work("w1"), message("lead", "assistant", "Done")],
      settled,
    );
    expect(ids(result)).toEqual(["agent-chatter:a1", "w1", "lead"]);
  });

  it("does not let a spawn row or a user message bridge a run", () => {
    const result = groupAgentChatter(
      [outgoing("a1"), outgoing("s", "spawn"), outgoing("a2")],
      settled,
    );
    expect(ids(result)).toEqual(["a1", "s", "a2"]);
    expect(
      ids(
        groupAgentChatter([outgoing("a1"), message("u", "user", "wait"), incoming("a2")], settled),
      ),
    ).toEqual(["a1", "u", "a2"]);
  });
});

describe("findLastUserMessageIndex", () => {
  it("finds the user's last real message and skips agent envelopes", () => {
    const entries = [
      message("u1", "user", "first"),
      message("u2", "user", "second"),
      incoming("in"),
      outgoing("out"),
    ];
    expect(findLastUserMessageIndex(entries)).toBe(1);
  });

  it("returns -1 without a user message", () => {
    expect(findLastUserMessageIndex([incoming("in"), message("a", "assistant", "hi")])).toBe(-1);
  });
});
