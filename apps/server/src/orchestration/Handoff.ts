import type { OrchestrationThread } from "@t3tools/contracts";

/**
 * Cross-provider handoff.
 *
 * A thread's native provider session is only a resume cache; the projected
 * transcript is the source of truth. When the user switches a running thread
 * to a provider that cannot resume the old session, the new provider starts
 * fresh and its first turn is prefixed with a prelude built here: a compact
 * recap plus the last few exchanges verbatim, and a pointer to the full
 * transcript on disk.
 *
 * The recap is deterministic on purpose: the usual reason to switch is that
 * the outgoing provider is out of quota, so it cannot be asked to summarize.
 */

export const HANDOFF_ACTIVITY_KIND = "viewcode.handoff";

export interface HandoffEndpoint {
  readonly instanceId: string;
  readonly model: string;
}

export interface HandoffDocument {
  /** Short recap rendered in the timeline card. */
  readonly summary: string;
  /** Full transcript written to disk for the new agent to read on demand. */
  readonly transcript: string;
  /** Builds the text prepended to the next provider turn. */
  readonly prelude: (transcriptPath: string | null) => string;
}

interface Exchange {
  readonly user: string;
  readonly assistant: ReadonlyArray<string>;
}

// The user's own words carry intent (which PR, which constraint, which
// codeword), so every user message travels verbatim and uncapped. Only the
// assistant's side is compacted.
const MAX_CONDENSED_ANSWER_CHARS = 700;
const MAX_LIST_ITEMS = 25;
const MAX_KEY_FACTS = 60;

/** Share of the incoming model's context window the carried conversation may use. */
export const HANDOFF_CONTEXT_SHARE = 0.25;
/** Assumed window when the incoming model has never reported one: small enough to be safe. */
export const DEFAULT_HANDOFF_CONTEXT_TOKENS = 128_000;

/** Rough token count for mixed prose and code; ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}… [truncated]`;
}

function exchangesOf(thread: OrchestrationThread): Exchange[] {
  const exchanges: Exchange[] = [];
  let current: { user: string; assistant: string[] } | null = null;
  for (const message of thread.messages) {
    if (message.role === "user") {
      if (current) exchanges.push(current);
      current = { user: message.text, assistant: [] };
    } else if (message.role === "assistant" && message.text.trim().length > 0) {
      if (!current) current = { user: "", assistant: [] };
      current.assistant.push(message.text);
    }
  }
  if (current) exchanges.push(current);
  return exchanges;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const field = (value as Record<string, unknown>)[key];
  return typeof field === "string" && field.trim().length > 0 ? field : undefined;
}

function toolWork(thread: OrchestrationThread): { edits: string[]; commands: string[] } {
  const edits = new Set<string>();
  const commands: string[] = [];
  for (const activity of thread.activities) {
    if (activity.kind !== "tool.completed") continue;
    const itemType = readString(activity.payload, "itemType");
    const label = readString(activity.payload, "detail") ?? readString(activity.payload, "title");
    if (!label) continue;
    if (itemType === "file_change") edits.add(label.split("\n")[0]!);
    else if (itemType === "command_execution") commands.push(label.split("\n")[0]!);
  }
  return { edits: [...edits].slice(-MAX_LIST_ITEMS), commands: commands.slice(-MAX_LIST_ITEMS) };
}

function latestPlan(thread: OrchestrationThread): string[] {
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index]!;
    if (activity.kind !== "turn.plan.updated") continue;
    const plan = (activity.payload as { plan?: unknown }).plan;
    if (!Array.isArray(plan)) return [];
    return plan.flatMap((entry) => {
      const step = readString(entry, "step");
      if (!step) return [];
      const status = readString(entry, "status") ?? "pending";
      return [`[${status}] ${step}`];
    });
  }
  return [];
}

export function describeModel(selection: HandoffEndpoint): string {
  return `${selection.model} (${selection.instanceId})`;
}

/** Every string inside an activity payload, for fact extraction and the transcript. */
function payloadText(payload: unknown, depth = 0): string[] {
  if (depth > 4 || payload === null || payload === undefined) return [];
  if (typeof payload === "string") return payload.trim() ? [payload] : [];
  if (Array.isArray(payload)) return payload.flatMap((entry) => payloadText(entry, depth + 1));
  if (typeof payload === "object") {
    return Object.values(payload as Record<string, unknown>).flatMap((value) =>
      payloadText(value, depth + 1),
    );
  }
  return [];
}

const FACT_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "link", pattern: /https?:\/\/[^\s)>\]"'`]+/g },
  { label: "PR/issue", pattern: /\b(?:PR|pull request|issue)\s*#\d+\b/gi },
  {
    label: "branch",
    pattern: /\b(?:checkout(?: -b)?|switch(?: -c)?|branch)\s+([\w./-]*[/-][\w./-]+)/g,
  },
  { label: "commit", pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g },
  {
    label: "path",
    pattern: /(?:^|[\s`'"(])((?:\.{0,2}\/|~\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,6})\b/g,
  },
];

/**
 * Concrete references the conversation depends on (links, PR numbers,
 * branches, commits, files), newest first. Deterministic, so it survives
 * any amount of compaction and needs no model.
 */
export function extractKeyFacts(texts: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const facts: string[] = [];
  for (let index = texts.length - 1; index >= 0; index -= 1) {
    for (const { label, pattern } of FACT_PATTERNS) {
      for (const match of texts[index]!.matchAll(pattern)) {
        const value = (match[1] ?? match[0]).trim().replace(/[.,;:]+$/, "");
        const key = value.toLowerCase();
        if (value.length < 4 || seen.has(key)) continue;
        seen.add(key);
        facts.push(`${label}: ${value}`);
        if (facts.length >= MAX_KEY_FACTS) return facts;
      }
    }
  }
  return facts;
}

export type HandoffMode = "full" | "compact";

export function buildHandoff(input: {
  readonly thread: OrchestrationThread;
  readonly from: HandoffEndpoint;
  readonly to: HandoffEndpoint;
  readonly recentExchanges: number;
  /** Context window of the incoming model, in tokens. */
  readonly targetContextTokens?: number;
}): HandoffDocument & { readonly mode: HandoffMode } {
  const { thread } = input;
  const exchanges = exchangesOf(thread);
  const { edits, commands } = toolWork(thread);
  const plan = latestPlan(thread);
  const windowTokens = input.targetContextTokens ?? DEFAULT_HANDOFF_CONTEXT_TOKENS;
  const budgetTokens = Math.floor(windowTokens * HANDOFF_CONTEXT_SHARE);

  const conversationTokens = exchanges.reduce(
    (total, exchange) =>
      total + estimateTokens(exchange.user) + estimateTokens(exchange.assistant.join("\n\n")),
    0,
  );
  const mode: HandoffMode = conversationTokens <= budgetTokens ? "full" : "compact";
  const keyFacts = extractKeyFacts([
    ...thread.messages.map((message) => message.text),
    ...thread.activities.flatMap((activity) => payloadText(activity.payload)),
  ]);

  // Compact mode spends the budget in priority order: the user's own words
  // (newest first), the last few replies verbatim, then older final answers.
  let remaining = budgetTokens - estimateTokens(keyFacts.join("\n"));
  const userTexts = exchanges.map(() => "");
  const replyTexts = exchanges.map(() => "");
  const replyVerbatim = exchanges.map(() => false);
  let omittedUserMessages = 0;
  let omittedReplies = 0;
  if (mode === "full") {
    exchanges.forEach((exchange, index) => {
      userTexts[index] = exchange.user.trim();
      replyTexts[index] = exchange.assistant.join("\n\n").trim();
      replyVerbatim[index] = true;
    });
  } else {
    for (let index = exchanges.length - 1; index >= 0; index -= 1) {
      const text = exchanges[index]!.user.trim();
      if (estimateTokens(text) <= remaining) {
        userTexts[index] = text;
        remaining -= estimateTokens(text);
      } else {
        userTexts[index] = `${clip(text, 300)} [longer; viewcode_search_history for the rest]`;
        remaining -= estimateTokens(userTexts[index]!);
        omittedUserMessages += 1;
      }
    }
    for (let index = exchanges.length - 1; index >= 0; index -= 1) {
      const recent = index >= exchanges.length - input.recentExchanges;
      const full = exchanges[index]!.assistant.join("\n\n").trim();
      const condensed = clip(exchanges[index]!.assistant.at(-1) ?? "", MAX_CONDENSED_ANSWER_CHARS);
      if (recent && estimateTokens(full) <= remaining) {
        replyTexts[index] = full;
        replyVerbatim[index] = true;
        remaining -= estimateTokens(full);
      } else if (condensed && estimateTokens(condensed) <= remaining) {
        replyTexts[index] = condensed;
        remaining -= estimateTokens(condensed);
      } else if (condensed) {
        omittedReplies += 1;
      }
    }
  }

  const verbatimReplies = replyVerbatim.filter(Boolean).length;
  const summaryLines = [
    `Thread "${thread.title}" moved from ${describeModel(input.from)} to ${describeModel(input.to)}.`,
    mode === "full"
      ? `Carried the whole conversation (${exchanges.length} exchange${exchanges.length === 1 ? "" : "s"}, ~${conversationTokens.toLocaleString("en-US")} tokens) and ${keyFacts.length} key facts.`
      : `Conversation (~${conversationTokens.toLocaleString("en-US")} tokens) exceeds ${Math.round(HANDOFF_CONTEXT_SHARE * 100)}% of the new model's window; carried ${exchanges.length - omittedUserMessages} of your ${exchanges.length} messages in full, ${verbatimReplies} replies verbatim and ${keyFacts.length} key facts. The new model summarizes the rest itself.`,
  ];
  if (edits.length > 0)
    summaryLines.push(
      `Files touched: ${edits.slice(0, 8).join(", ")}${edits.length > 8 ? ", …" : ""}`,
    );

  const conversation = exchanges.map((exchange, index) => {
    const number = index + 1;
    const reply =
      replyTexts[index] ||
      (exchange.assistant.length > 0 ? "(omitted; viewcode_search_history)" : "(no reply)");
    return [
      `### ${number}. User`,
      userTexts[index] || "(no user message)",
      "",
      `### ${number}. Assistant${replyVerbatim[index] ? "" : " (final answer, condensed)"}`,
      reply,
    ].join("\n");
  });

  const recap: string[] = [];
  if (keyFacts.length > 0)
    recap.push(
      `## Key facts (links, PRs, branches, commits, files)\n${keyFacts.map((fact) => `- ${fact}`).join("\n")}`,
    );
  if (conversation.length > 0) recap.push(`## Conversation so far\n\n${conversation.join("\n\n")}`);
  if (edits.length > 0)
    recap.push(`## Files changed so far\n${edits.map((path) => `- ${path}`).join("\n")}`);
  if (commands.length > 0)
    recap.push(`## Commands run\n${commands.map((command) => `- ${command}`).join("\n")}`);
  if (plan.length > 0) recap.push(`## Plan / todos\n${plan.map((step) => `- ${step}`).join("\n")}`);

  const events = [
    ...thread.messages.map((message) => ({
      at: message.createdAt,
      text: `## ${message.role} · ${message.createdAt}\n\n${message.text.trim()}\n`,
    })),
    ...thread.activities
      .filter((activity) => activity.kind === "tool.completed")
      .map((activity) => ({
        at: activity.createdAt,
        text: `## tool · ${activity.createdAt}\n\n${payloadText(activity.payload).join("\n").trim()}\n`,
      })),
  ].sort((left, right) => (left.at ?? "").localeCompare(right.at ?? ""));
  const transcript = [
    `# Transcript: ${thread.title}`,
    "",
    ...events.map((event) => event.text),
  ].join("\n");

  const compactInstructions = [
    "This conversation is too long to hand over whole, so part of it is condensed below.",
    "Your first job, before answering: build your own working summary of what was asked, decided and done.",
    "Use the viewcode_search_history tool (search by PR number, file name, error text or topic) or read the full transcript file for anything not shown here.",
    "Never ask the user about earlier work before searching for it.",
  ];

  return {
    mode,
    summary: summaryLines.join("\n"),
    transcript,
    prelude: (transcriptPath) =>
      [
        "<handoff>",
        `You are continuing an existing conversation. It was previously handled by ${describeModel(input.from)}; you (${describeModel(input.to)}) are taking over with no access to that model's session.`,
        "Treat everything below as shared context you already know. Do not repeat finished work; continue from where it left off.",
        ...(mode === "compact" ? compactInstructions : []),
        transcriptPath
          ? `The full transcript, including tool results, is at ${transcriptPath}.`
          : "",
        "",
        recap.join("\n\n"),
        "</handoff>",
        "",
        "The user's new message follows.",
        "",
      ]
        .filter((line, index, all) => line !== "" || all[index - 1] !== "")
        .join("\n"),
  };
}

/** True when moving between these selections cannot reuse the native session. */
export function selectionNeedsHandoff(input: {
  readonly currentDriverKind: string;
  readonly desiredDriverKind: string;
  readonly currentContinuationKey: string;
  readonly desiredContinuationKey: string;
}): boolean {
  return (
    input.currentDriverKind !== input.desiredDriverKind ||
    input.currentContinuationKey !== input.desiredContinuationKey
  );
}
