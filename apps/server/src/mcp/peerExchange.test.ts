import { ThreadId } from "@t3tools/contracts";
import { formatPeerChatMessage, parseAgentMessage } from "@t3tools/shared/agentMessages";
import { describe, expect, it } from "vite-plus/test";

import { isIndependentChat, type PeerMessage, peerExchangeStep } from "./peerExchange.ts";

const chat = (id: string, root = id, kind?: string) => ({
  id: ThreadId.make(id),
  kind,
  lineage: { rootThreadId: ThreadId.make(root) },
});

const peer = (
  id: string,
  from: PeerMessage["from"],
  at: number,
  body: string,
  inReplyTo: string | null = null,
): PeerMessage => ({
  id,
  from,
  createdAtMs: at,
  text: formatPeerChatMessage({
    messageId: id,
    fromThreadId: from,
    fromName: from,
    inReplyTo,
    body,
  }),
});

describe("isIndependentChat", () => {
  it("separates chats the user started from one agent tree", () => {
    expect(isIndependentChat(chat("embedded"), chat("counterfactual"))).toBe(true);
    // A subagent, or a fork, keeps its root: delegation stays open.
    expect(isIndependentChat(chat("child", "parent"), chat("parent"))).toBe(false);
    expect(isIndependentChat(chat("parent"), chat("child", "parent"))).toBe(false);
    expect(isIndependentChat(chat("same"), chat("same"))).toBe(false);
    // RockBot already asks its user before every write.
    expect(isIndependentChat(chat("rockbot", "rockbot", "orchestrator"), chat("b"))).toBe(false);
  });
});

describe("peerExchangeStep", () => {
  it("asks the user for a first message", () => {
    expect(peerExchangeStep([], "Can you yield Docker?")).toEqual({ kind: "request" });
  });

  it("lets the other chat answer an approved request once, without asking", () => {
    const request = peer("m1", "target", 1, "Can you yield Docker?");
    expect(peerExchangeStep([request], "Done, it's free.")).toEqual({
      kind: "reply",
      inReplyTo: "m1",
    });
    // The reply went out: anything more is a new request for the user.
    const reply = peer("m2", "caller", 2, "Done, it's free.", "m1");
    expect(peerExchangeStep([request, reply], "Ping me when you finish")).toEqual({
      kind: "request",
    });
  });

  it("never answers a reply for free, so acknowledgements cannot loop", () => {
    const reply = peer("m2", "target", 2, "Done, it's free.", "m1");
    expect(peerExchangeStep([reply], "Thanks!")).toEqual({ kind: "request" });
  });

  it("refuses to resend an unanswered message unchanged", () => {
    const sent = peer("m1", "caller", 1, "Can you yield Docker?");
    expect(peerExchangeStep([sent], "Can you yield Docker? ")).toEqual({ kind: "duplicate" });
  });

  it("answers a plain message from before envelopes by its message id", () => {
    const legacy: PeerMessage = { id: "old", from: "target", createdAtMs: 1, text: "status?" };
    expect(peerExchangeStep([legacy], "Still running.")).toEqual({
      kind: "reply",
      inReplyTo: "old",
    });
    expect(parseAgentMessage(peer("m", "caller", 1, "x", "old").text)?.inReplyTo).toBe("old");
  });
});
