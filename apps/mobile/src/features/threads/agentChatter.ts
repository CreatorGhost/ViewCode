import { parseAgentMessage, type AgentMessageEnvelope } from "@t3tools/shared/agentMessages";

import { isContextCompactionActivityGroup, type ThreadFeedEntry } from "../../lib/threadActivity";

/** The collapsible header a run of back-to-back agent messages folds into. */
export interface AgentChatterHeaderEntry {
  readonly type: "agent-chatter";
  /** `agent-chatter:<id of the run's first agent row>`, stable while the run grows. */
  readonly id: string;
  /** Override key and group id: the first agent row's id. */
  readonly groupId: string;
  readonly createdAt: string;
  /** Agent rows in the run; work rows between them are not counted. */
  readonly messageCount: number;
  readonly live: boolean;
  readonly expanded: boolean;
}

export interface AgentChatterResult<Entry> {
  readonly entries: ReadonlyArray<Entry | AgentChatterHeaderEntry>;
  /** Ids of the entries rendered inside an expanded group (they get the left rule). */
  readonly memberIds: ReadonlySet<string>;
}

const NO_MEMBERS: ReadonlySet<string> = new Set();

type MessageEntry = Extract<ThreadFeedEntry, { readonly type: "message" }>;

// Messages are immutable and shared across renders, so a text is parsed once.
const envelopeCache = new WeakMap<MessageEntry["message"], AgentMessageEnvelope | null>();

/** The envelope of a user message another agent sent this thread; null for anything else. */
export function readAgentEnvelope(message: MessageEntry["message"]): AgentMessageEnvelope | null {
  if (message.role !== "user") return null;
  const cached = envelopeCache.get(message);
  if (cached !== undefined) return cached;
  const envelope = parseAgentMessage(message.text);
  envelopeCache.set(message, envelope);
  return envelope;
}

/** An agent-to-agent message, in either direction. A spawn is its own row, not chatter. */
export function isAgentMessageEntry(entry: ThreadFeedEntry): boolean {
  if (entry.type === "agent-message") return entry.sent.kind !== "spawn";
  return entry.type === "message" && readAgentEnvelope(entry.message) !== null;
}

/**
 * Rows that may sit between two agent messages without ending the run: tool
 * work and reasoning chrome, never anything the user would read as a message.
 */
function isWorkEntry(entry: ThreadFeedEntry): boolean {
  switch (entry.type) {
    case "work-toggle":
      return true;
    case "activity-group":
      return !isContextCompactionActivityGroup(entry);
    case "message":
      return entry.message.role === "reasoning";
    default:
      return false;
  }
}

/**
 * Folds runs of two or more agent messages (with only work rows between them)
 * behind one header row. A run is live while nothing but work rows or the
 * thinking slot follows it and the thread is working; live runs default open,
 * finished ones closed, and `overrides` (by group id) win either way. Work
 * after a run's last agent message stays outside the group, as does the
 * thinking slot. Returns the input untouched when nothing folds.
 */
export function groupAgentChatter<Entry extends ThreadFeedEntry>(
  entries: ReadonlyArray<Entry>,
  options: {
    readonly overrides: Readonly<Record<string, boolean>>;
    readonly working: boolean;
  },
): AgentChatterResult<Entry> {
  const output: Array<Entry | AgentChatterHeaderEntry> = [];
  const memberIds = new Set<string>();
  let grouped = false;

  // Flushes entries[start..end] (inclusive of the last agent row) into output.
  const emitRun = (start: number, end: number, count: number) => {
    const first = entries[start]!;
    if (count < 2) {
      for (let index = start; index <= end; index += 1) output.push(entries[index]!);
      return;
    }
    grouped = true;
    let live = options.working;
    for (let index = end + 1; live && index < entries.length; index += 1) {
      const trailing = entries[index]!;
      live = trailing.type === "thinking" || isWorkEntry(trailing);
    }
    const expanded = options.overrides[first.id] ?? live;
    output.push({
      type: "agent-chatter",
      id: `agent-chatter:${first.id}`,
      groupId: first.id,
      createdAt: first.createdAt,
      messageCount: count,
      live,
      expanded,
    });
    if (!expanded) return;
    for (let index = start; index <= end; index += 1) {
      const member = entries[index]!;
      memberIds.add(member.id);
      output.push(member);
    }
  };

  let runStart = -1;
  let lastAgent = -1;
  let agentCount = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (isAgentMessageEntry(entry)) {
      if (runStart < 0) runStart = index;
      lastAgent = index;
      agentCount += 1;
      continue;
    }
    if (runStart >= 0 && isWorkEntry(entry)) continue;
    if (runStart >= 0) {
      emitRun(runStart, lastAgent, agentCount);
      // Work rows after the run's last agent row were held back; they stay outside it.
      for (let held = lastAgent + 1; held < index; held += 1) output.push(entries[held]!);
      runStart = -1;
      agentCount = 0;
    }
    output.push(entry);
  }
  if (runStart >= 0) {
    emitRun(runStart, lastAgent, agentCount);
    for (let held = lastAgent + 1; held < entries.length; held += 1) output.push(entries[held]!);
  }
  return grouped ? { entries: output, memberIds } : { entries, memberIds: NO_MEMBERS };
}

/** Index of the user's own last message (pending ones included), skipping agent envelopes. */
export function findLastUserMessageIndex(
  entries: ReadonlyArray<ThreadFeedEntry | AgentChatterHeaderEntry>,
): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (
      entry.type === "message" &&
      entry.message.role === "user" &&
      readAgentEnvelope(entry.message) === null
    ) {
      return index;
    }
  }
  return -1;
}
