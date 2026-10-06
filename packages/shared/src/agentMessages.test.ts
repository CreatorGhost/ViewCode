import { describe, expect, it } from "@effect/vitest";

import {
  formatAgentMessage,
  parseAgentMessage,
  readAgentMessageSentPayload,
} from "./agentMessages.ts";

describe("agent message envelope", () => {
  it("round-trips sender, reply routing and a multi-line body", () => {
    const text = formatAgentMessage({
      messageId: "m-1",
      fromThreadId: "t-parent",
      fromName: 'Lead "audit"',
      replyExpected: true,
      inReplyTo: null,
      body: "Audit apps/web.\nReport gaps.",
    });

    expect(text).toContain('response_id="m-1"');
    expect(parseAgentMessage(text)).toEqual({
      messageId: "m-1",
      fromThreadId: "t-parent",
      fromName: 'Lead "audit"',
      replyExpected: true,
      inReplyTo: null,
      body: "Audit apps/web.\nReport gaps.",
    });
  });

  it("marks replies and ignores ordinary user text", () => {
    const reply = formatAgentMessage({
      messageId: "m-2",
      fromThreadId: "t-child",
      fromName: "Frontend audit",
      replyExpected: false,
      inReplyTo: "m-1",
      body: "Done: 3 gaps.",
    });

    expect(parseAgentMessage(reply)?.inReplyTo).toBe("m-1");
    expect(parseAgentMessage("hello <viewcode-agent-message>")).toBeNull();
  });
});

describe("readAgentMessageSentPayload task", () => {
  const base = {
    messageId: "m1",
    toThreadId: "t2",
    toName: "Sol",
    body: "Review the diff panel",
    kind: "spawn",
  };

  it("keeps a spawn's task trimmed", () => {
    expect(readAgentMessageSentPayload({ ...base, task: "  diff panel design " })?.task).toBe(
      "diff panel design",
    );
  });

  it("drops a missing or blank task", () => {
    expect(readAgentMessageSentPayload(base)).not.toHaveProperty("task");
    expect(readAgentMessageSentPayload({ ...base, task: "  " })).not.toHaveProperty("task");
  });
});
