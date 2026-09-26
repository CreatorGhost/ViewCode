/**
 * Agent-to-agent message envelope.
 *
 * A message one ViewCode agent sends another is delivered as a user turn on
 * the receiving thread. The envelope keeps sender identity and reply routing
 * in the text itself so every provider sees the same thing, and so clients
 * can render the turn as a "from" card instead of a plain user bubble.
 */

export const AGENT_MESSAGE_TAG = "viewcode-agent-message";

export interface AgentMessageEnvelope {
  readonly messageId: string;
  readonly fromThreadId: string;
  readonly fromName: string;
  readonly replyExpected: boolean;
  /** Set when this message answers an earlier one. */
  readonly inReplyTo: string | null;
  readonly body: string;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/\n/g, " ");
}

function unescapeAttribute(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

export function formatAgentMessage(envelope: AgentMessageEnvelope): string {
  const attributes = [
    `from="${escapeAttribute(envelope.fromName)}"`,
    `from-id="${escapeAttribute(envelope.fromThreadId)}"`,
    `message-id="${escapeAttribute(envelope.messageId)}"`,
    `reply-expected="${envelope.replyExpected ? "true" : "false"}"`,
    ...(envelope.inReplyTo ? [`in-reply-to="${escapeAttribute(envelope.inReplyTo)}"`] : []),
  ].join(" ");
  const footer = envelope.inReplyTo
    ? `This is ${envelope.fromName}'s reply to your message ${envelope.inReplyTo}.`
    : envelope.replyExpected
      ? `A reply is expected. Answer with the viewcode_send_message tool (to="${envelope.fromThreadId}", response_id="${envelope.messageId}"). If you finish without calling it, your final answer is sent back automatically.`
      : "No reply is required.";
  return `<${AGENT_MESSAGE_TAG} ${attributes}>\n${envelope.body.trim()}\n</${AGENT_MESSAGE_TAG}>\n\n${footer}`;
}

const HEADER = new RegExp(`^<${AGENT_MESSAGE_TAG}((?:\\s+[a-z-]+="[^"]*")*)\\s*>\\n`);
const ATTRIBUTE = /([a-z-]+)="([^"]*)"/g;

/** Parses a delivered agent message; null for ordinary user text. */
export function parseAgentMessage(text: string): AgentMessageEnvelope | null {
  const header = HEADER.exec(text);
  if (!header) return null;
  const attributes = new Map<string, string>();
  for (const match of header[1]!.matchAll(ATTRIBUTE)) {
    attributes.set(match[1]!, unescapeAttribute(match[2]!));
  }
  const close = text.indexOf(`\n</${AGENT_MESSAGE_TAG}>`, header[0].length - 1);
  if (close === -1) return null;
  const messageId = attributes.get("message-id");
  const fromThreadId = attributes.get("from-id");
  const fromName = attributes.get("from");
  if (!messageId || !fromThreadId || fromName === undefined) return null;
  return {
    messageId,
    fromThreadId,
    fromName,
    replyExpected: attributes.get("reply-expected") === "true",
    inReplyTo: attributes.get("in-reply-to") ?? null,
    body: text.slice(header[0].length, close),
  };
}

/** Activity kind recorded on the sender's thread for every message it sends. */
export const AGENT_MESSAGE_SENT_ACTIVITY_KIND = "viewcode.agent-message.sent";

export interface AgentMessageSentPayload {
  readonly messageId: string;
  readonly toThreadId: string;
  readonly toName: string;
  readonly body: string;
  readonly replyExpected: boolean;
  readonly inReplyTo: string | null;
  /** "spawn" when the message created the receiving agent. */
  readonly kind: "message" | "spawn";
  readonly delivery: "started" | "queued";
}
