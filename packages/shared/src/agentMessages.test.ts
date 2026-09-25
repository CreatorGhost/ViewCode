import { describe, expect, it } from "@effect/vitest";

import { formatAgentMessage, parseAgentMessage } from "./agentMessages.ts";

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
