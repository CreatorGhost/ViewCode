import type { OrchestrationThread } from "@t3tools/contracts";

/**
 * Cross-provider handoff.
 *
 * A thread's native provider session is only a resume cache; the projected
 * transcript is the source of truth. When the user switches a running thread
 * to a provider that cannot resume the old session, the new provider starts
 * fresh and its first turn is prefixed with a prelude built here, plus a
 * pointer to the full transcript on disk.
 *
 * The recap is deterministic on purpose: the usual reason to switch is that
 * the outgoing provider is out of quota, so it cannot be asked to summarize.
 *
 * Budget: the whole rendered prelude (header, recap, omission note) fits in
 * HANDOFF_CONTEXT_SHARE of the incoming model's window. The only overrun is a
 * transcript path longer than TRANSCRIPT_PATH_ALLOWANCE, or a window so small
 * that the fixed header alone exceeds it. When everything does not fit, the
 * user's own messages win over the model's replies, and the prelude says what
 * was left out and how to recover it.
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

const MAX_CONDENSED_ANSWER_CHARS = 700;
const MAX_CLIPPED_USER_CHARS = 300;
const MAX_LIST_ITEMS = 25;
const MAX_LIST_ITEM_CHARS = 200;
const MAX_KEY_FACTS = 60;
const MAX_KEY_FACT_CHARS = 200;
/** Header room reserved for the transcript path; a longer path overruns the budget by the excess. */
export const TRANSCRIPT_PATH_ALLOWANCE = 400;

/** Share of the incoming model's context window the carried conversation may use. */
export const HANDOFF_CONTEXT_SHARE = 0.25;
/** Assumed window when the incoming model has never reported one: small enough to be safe. */
export const DEFAULT_HANDOFF_CONTEXT_TOKENS = 128_000;

/** Rough token count for mixed prose and code; ~4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function clip(text: string, max: number, marker = "… [truncated]"): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}${marker}`;
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

const listItem = (text: string) => clip(text.split("\n")[0]!, MAX_LIST_ITEM_CHARS, "…");

function toolWork(thread: OrchestrationThread): { edits: string[]; commands: string[] } {
  const edits = new Set<string>();
  const commands: string[] = [];
  for (const activity of thread.activities) {
    if (activity.kind !== "tool.completed") continue;
    const itemType = readString(activity.payload, "itemType");
    const label = readString(activity.payload, "detail") ?? readString(activity.payload, "title");
    if (!label) continue;
    if (itemType === "file_change") edits.add(listItem(label));
    else if (itemType === "command_execution") commands.push(listItem(label));
  }
  return { edits: [...edits].slice(-MAX_LIST_ITEMS), commands: commands.slice(-MAX_LIST_ITEMS) };
}

function latestPlan(thread: OrchestrationThread): string[] {
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index]!;
    if (activity.kind !== "turn.plan.updated") continue;
    const plan = (activity.payload as { plan?: unknown }).plan;
    if (!Array.isArray(plan)) return [];
    return plan.slice(0, MAX_LIST_ITEMS).flatMap((entry) => {
      const step = readString(entry, "step");
      if (!step) return [];
      const status = readString(entry, "status") ?? "pending";
      return [listItem(`[${status}] ${step}`)];
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

// Root-level file names need a known extension, or prose like "e.g." and
// "example.com" would read as files.
const FILE_EXTENSIONS =
  "md|mdx|json|jsonc|ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rs|go|java|kt|swift|rb|php|c|h|cc|cpp|hpp|cs|css|scss|html|vue|svelte|yml|yaml|toml|lock|sh|ps1|sql|txt|env|xml|gradle|ini|cfg|conf|csv|proto|graphql|dockerfile";
// Library names that look like root-level files.
const NOT_A_FILE =
  /^(?:node|next|nuxt|vue|react|express|three|d3|chart|ember|angular|deno|bun)\.js$/i;

const FACT_PATTERNS: ReadonlyArray<{ readonly label: string; readonly pattern: RegExp }> = [
  { label: "link", pattern: /https?:\/\/[^\s)>\]"'`]+/g },
  { label: "PR/issue", pattern: /\b(?:PR|pull request|issue)\s*#\d+\b/gi },
  {
    label: "branch",
    pattern: /\b(?:checkout(?: -b)?|switch(?: -c)?|branch)\s+([\w./-]*[/-][\w./-]+)/g,
  },
  {
    // A hex run is a commit only next to a git word; bare hex (hashes, ids,
    // colors) is not.
    label: "commit",
    pattern:
      /\b(?:commits?|committed|sha1?|hash|rev(?:ision)?|cherry-pick(?:ed)?|revert(?:ed|s)?|git\s+(?:show|checkout|reset|rebase|revert|log|diff|cherry-pick|bisect|tag|branch))\b(?:\s+(?:is|was|at|to|of|on|as|--hard|--soft|--onto|-b))?[\s:#=(`'"]*(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])([0-9a-f]{7,40})\b/gi,
  },
  {
    label: "path",
    pattern: /(?:^|[\s`'"(])((?:\.{0,2}\/|~\/)?[\w.-]+(?:\/[\w.-]+)+\.[A-Za-z0-9]{1,6})\b/g,
  },
  {
    label: "path",
    pattern:
      /(?:^|[\s`'"(])((?:[A-Za-z]:|\.{1,2})\\(?:[\w.-]+\\)*[\w.-]+|[\w.-]+(?:\\[\w.-]+)+\.[A-Za-z0-9]{1,6})(?![\w\\])/g,
  },
  {
    label: "file",
    pattern: new RegExp(
      `(?:^|[\\s\`'"(])([\\w-]+(?:\\.[\\w-]+)*\\.(?:${FILE_EXTENSIONS}))(?![\\w/\\\\.-])`,
      "gi",
    ),
  },
];

/**
 * Concrete references the conversation depends on (links, PR numbers,
 * branches, commits, files), newest first. Deterministic, so it survives
 * any amount of compaction and needs no model. Count and length are capped.
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
        if (label === "file" && NOT_A_FILE.test(value)) continue;
        seen.add(key);
        facts.push(`${label}: ${clip(value, MAX_KEY_FACT_CHARS, "…")}`);
        if (facts.length >= MAX_KEY_FACTS) return facts;
      }
    }
  }
  return facts;
}

export type HandoffMode = "full" | "compact";

/** What the recap carries; null marks an item left out. */
interface Selection {
  readonly user: Array<string | null>;
  readonly userClipped: boolean[];
  readonly reply: Array<string | null>;
  readonly replyVerbatim: boolean[];
  readonly facts: string[];
  readonly plan: string[];
  readonly edits: string[];
  readonly commands: string[];
}

const SEARCH_HINT = "viewcode_search_history";
const NOT_SHOWN = `(not shown; ${SEARCH_HINT})`;
const CONDENSED_SUFFIX = " (final answer, condensed)";
// Per-item overheads, upper bounds; the rendered text is checked anyway.
const EXCHANGE_OVERHEAD_CHARS = 100;
const GAP_LINE_CHARS = 64;
const SECTION_HEADING_CHARS = 64;
const OMISSION_NOTE_SLACK_CHARS = 120;

function renderConversation(exchanges: ReadonlyArray<Exchange>, selection: Selection): string {
  const blocks: string[] = [];
  let gapStart = -1;
  const flushGap = (end: number) => {
    if (gapStart < 0) return;
    const range = gapStart === end ? `${gapStart + 1}` : `${gapStart + 1}–${end + 1}`;
    blocks.push(`### ${range}. ${NOT_SHOWN}`);
    gapStart = -1;
  };
  exchanges.forEach((exchange, index) => {
    const user = selection.user[index] ?? null;
    const reply = selection.reply[index] ?? null;
    if (user === null && reply === null) {
      if (gapStart < 0) gapStart = index;
      return;
    }
    flushGap(index - 1);
    const number = index + 1;
    const userBlock =
      user === null
        ? `### ${number}. User ${NOT_SHOWN}`
        : `### ${number}. User\n${user || "(no user message)"}`;
    const replyBlock =
      reply !== null
        ? `### ${number}. Assistant${selection.replyVerbatim[index] ? "" : CONDENSED_SUFFIX}\n${reply}`
        : `### ${number}. Assistant ${exchange.assistant.length > 0 ? NOT_SHOWN : "(no reply)"}`;
    blocks.push(`${userBlock}\n\n${replyBlock}`);
  });
  flushGap(exchanges.length - 1);
  return blocks.join("\n\n");
}

function renderRecap(exchanges: ReadonlyArray<Exchange>, selection: Selection): string {
  const recap: string[] = [];
  if (selection.facts.length > 0)
    recap.push(
      `## Key facts (links, PRs, branches, commits, files)\n${selection.facts.map((fact) => `- ${fact}`).join("\n")}`,
    );
  if (exchanges.length > 0)
    recap.push(`## Conversation so far\n\n${renderConversation(exchanges, selection)}`);
  if (selection.plan.length > 0)
    recap.push(`## Plan / todos\n${selection.plan.map((step) => `- ${step}`).join("\n")}`);
  if (selection.edits.length > 0)
    recap.push(`## Files changed so far\n${selection.edits.map((path) => `- ${path}`).join("\n")}`);
  if (selection.commands.length > 0)
    recap.push(
      `## Commands run\n${selection.commands.map((command) => `- ${command}`).join("\n")}`,
    );
  return recap.join("\n\n");
}

interface Omissions {
  readonly userClipped: number;
  readonly userOmitted: number;
  readonly repliesCondensed: number;
  readonly repliesOmitted: number;
  readonly facts: number;
  readonly lists: number;
}

function countOmissions(
  exchanges: ReadonlyArray<Exchange>,
  selection: Selection,
  all: { facts: number; lists: number },
): Omissions {
  let userClipped = 0;
  let userOmitted = 0;
  let repliesCondensed = 0;
  let repliesOmitted = 0;
  exchanges.forEach((exchange, index) => {
    if (exchange.user.trim()) {
      if (selection.user[index] === null) userOmitted += 1;
      else if (selection.userClipped[index]) userClipped += 1;
    }
    if (exchange.assistant.length > 0) {
      if (selection.reply[index] === null) repliesOmitted += 1;
      else if (!selection.replyVerbatim[index]) repliesCondensed += 1;
    }
  });
  return {
    userClipped,
    userOmitted,
    repliesCondensed,
    repliesOmitted,
    facts: all.facts - selection.facts.length,
    lists: all.lists - selection.plan.length - selection.edits.length - selection.commands.length,
  };
}

function renderOmissionNote(omissions: Omissions, userTotal: number): string {
  const parts: string[] = [];
  if (omissions.userClipped > 0)
    parts.push(`${omissions.userClipped} of the user's ${userTotal} messages are clipped`);
  if (omissions.userOmitted > 0)
    parts.push(`${omissions.userOmitted} of the user's ${userTotal} messages are left out`);
  if (omissions.repliesCondensed > 0)
    parts.push(`${omissions.repliesCondensed} replies are condensed to their final answer`);
  if (omissions.repliesOmitted > 0) parts.push(`${omissions.repliesOmitted} replies are left out`);
  if (omissions.facts > 0) parts.push(`${omissions.facts} key facts are left out`);
  if (omissions.lists > 0)
    parts.push(`${omissions.lists} plan steps, changed files or commands are left out`);
  if (parts.length === 0) return "";
  return [
    "## Not shown here",
    `To fit the budget, ${parts.join("; ")}.`,
    `Recover any of it with ${SEARCH_HINT} (by PR number, file name, error text or topic) or from the full transcript file named above.`,
  ].join("\n");
}

export function buildHandoff(input: {
  readonly thread: OrchestrationThread;
  readonly from: HandoffEndpoint;
  readonly to: HandoffEndpoint;
  readonly recentExchanges: number;
  /** Context window of the incoming model, in tokens. */
  readonly targetContextTokens?: number;
}): HandoffDocument & { readonly mode: HandoffMode; readonly budgetTokens: number } {
  const { thread } = input;
  const exchanges = exchangesOf(thread);
  const { edits, commands } = toolWork(thread);
  const plan = latestPlan(thread);
  const keyFacts = extractKeyFacts([
    ...thread.messages.map((message) => message.text),
    ...thread.activities.flatMap((activity) => payloadText(activity.payload)),
  ]);
  const windowTokens = input.targetContextTokens ?? DEFAULT_HANDOFF_CONTEXT_TOKENS;
  const budgetTokens = Math.floor(windowTokens * HANDOFF_CONTEXT_SHARE);
  const budgetChars = budgetTokens * 4;
  const userTotal = exchanges.filter((exchange) => exchange.user.trim()).length;
  const conversationTokens = exchanges.reduce(
    (total, exchange) =>
      total + estimateTokens(exchange.user) + estimateTokens(exchange.assistant.join("\n\n")),
    0,
  );

  const render = (mode: HandoffMode, selection: Selection, transcriptPath: string | null) => {
    const note =
      mode === "compact"
        ? renderOmissionNote(
            countOmissions(exchanges, selection, {
              facts: keyFacts.length,
              lists: plan.length + edits.length + commands.length,
            }),
            userTotal,
          )
        : "";
    const lines = [
      "<handoff>",
      `You are continuing an existing conversation. It was previously handled by ${describeModel(input.from)}; you (${describeModel(input.to)}) are taking over with no access to that model's session.`,
      "Treat everything below as shared context you already know. Do not repeat finished work; continue from where it left off.",
      ...(mode === "compact"
        ? [
            "This conversation is too long to hand over whole, so part of it is condensed or left out below.",
            "Your first job, before answering: build your own working summary of what was asked, decided and done.",
            `Use the ${SEARCH_HINT} tool (search by PR number, file name, error text or topic) or read the full transcript file for anything not shown here.`,
            "Never ask the user about earlier work before searching for it.",
          ]
        : []),
      ...(transcriptPath
        ? [
            `The full transcript (every message and every completed tool result) is at ${transcriptPath}.`,
          ]
        : []),
      "",
      renderRecap(exchanges, selection),
      ...(note ? ["", note] : []),
      "</handoff>",
      "",
      "The user's new message follows.",
      "",
    ];
    return lines.filter((line, index, all) => line !== "" || all[index - 1] !== "").join("\n");
  };
  // Selection is sized against the longest path the header reserves room for.
  const sizingPath = "x".repeat(TRANSCRIPT_PATH_ALLOWANCE);

  const whole: Selection = {
    user: exchanges.map((exchange) => exchange.user.trim()),
    userClipped: exchanges.map(() => false),
    reply: exchanges.map((exchange) => exchange.assistant.join("\n\n").trim() || null),
    replyVerbatim: exchanges.map(() => true),
    facts: keyFacts,
    plan,
    edits,
    commands,
  };
  const mode: HandoffMode =
    render("full", whole, sizingPath).length <= budgetChars ? "full" : "compact";

  let selection = whole;
  if (mode === "compact") {
    const picked: Selection = {
      user: exchanges.map(() => null),
      userClipped: exchanges.map(() => false),
      reply: exchanges.map(() => null),
      replyVerbatim: exchanges.map(() => false),
      facts: [],
      plan: [],
      edits: [],
      commands: [],
    };
    // Undo stack in priority order, so the final check can shed the least important first.
    const undo: Array<() => void> = [];
    const opened = exchanges.map(() => false);
    let remaining = 0;
    const exchangeCost = (index: number) =>
      opened[index] ? 0 : EXCHANGE_OVERHEAD_CHARS + GAP_LINE_CHARS;
    const take = (cost: number, apply: () => void, revert: () => void) => {
      if (cost > remaining) return false;
      remaining -= cost;
      apply();
      undo.push(revert);
      return true;
    };
    const openExchange = (index: number) => {
      const wasOpen = opened[index]!;
      opened[index] = true;
      return () => {
        opened[index] = wasOpen;
      };
    };

    const fill = () => {
      // (a) The user's own messages, newest first, in full.
      for (let index = exchanges.length - 1; index >= 0; index -= 1) {
        const text = exchanges[index]!.user.trim();
        if (!text || picked.user[index] !== null) continue;
        let reopen = () => {};
        take(
          exchangeCost(index) + text.length,
          () => {
            picked.user[index] = text;
            reopen = openExchange(index);
          },
          () => {
            picked.user[index] = null;
            reopen();
          },
        );
      }
      // (b) Older messages that did not fit whole, clipped, while room remains.
      for (let index = exchanges.length - 1; index >= 0; index -= 1) {
        const text = exchanges[index]!.user.trim();
        if (!text || picked.user[index] !== null) continue;
        const clipped = clip(
          text,
          MAX_CLIPPED_USER_CHARS,
          `… [clipped, ${(text.length - MAX_CLIPPED_USER_CHARS).toLocaleString("en-US")} more chars; ${SEARCH_HINT} or the transcript]`,
        );
        let reopen = () => {};
        take(
          exchangeCost(index) + clipped.length,
          () => {
            picked.user[index] = clipped;
            picked.userClipped[index] = true;
            reopen = openExchange(index);
          },
          () => {
            picked.user[index] = null;
            picked.userClipped[index] = false;
            reopen();
          },
        );
      }
      // (c) Replies, newest first: the last few verbatim when they fit, else condensed.
      for (let index = exchanges.length - 1; index >= 0; index -= 1) {
        const assistant = exchanges[index]!.assistant;
        if (assistant.length === 0 || picked.reply[index] !== null) continue;
        const full = assistant.join("\n\n").trim();
        const condensed = clip(assistant.at(-1) ?? "", MAX_CONDENSED_ANSWER_CHARS);
        const recent = index >= exchanges.length - input.recentExchanges;
        const options: Array<{ text: string; verbatim: boolean }> = [];
        if (recent) options.push({ text: full, verbatim: true });
        if (condensed && condensed !== full) options.push({ text: condensed, verbatim: false });
        else if (!recent) options.push({ text: full, verbatim: true });
        for (const option of options) {
          let reopen = () => {};
          const taken = take(
            exchangeCost(index) + option.text.length + CONDENSED_SUFFIX.length + 2,
            () => {
              picked.reply[index] = option.text;
              picked.replyVerbatim[index] = option.verbatim;
              reopen = openExchange(index);
            },
            () => {
              picked.reply[index] = null;
              picked.replyVerbatim[index] = false;
              reopen();
            },
          );
          if (taken) break;
        }
      }
      // (d) Key facts, then (e) plan, changed files and commands.
      const addList = (source: ReadonlyArray<string>, target: string[]) => {
        for (const item of source) {
          if (target.includes(item)) continue;
          take(
            item.length + 3 + (target.length === 0 ? SECTION_HEADING_CHARS : 0),
            () => target.push(item),
            () => target.pop(),
          );
        }
      };
      addList(keyFacts, picked.facts);
      addList(plan, picked.plan);
      addList(edits, picked.edits);
      addList(commands, picked.commands);
    };

    // Costs are upper bounds, so refill from the real slack until nothing more fits.
    for (let round = 0; round < 6; round += 1) {
      remaining =
        budgetChars - render("compact", picked, sizingPath).length - OMISSION_NOTE_SLACK_CHARS;
      const before = undo.length;
      fill();
      if (undo.length === before) break;
    }
    // The costs above are estimates; the rendered text is what must fit.
    while (undo.length > 0 && render("compact", picked, sizingPath).length > budgetChars) {
      undo.pop()!();
    }
    selection = picked;
  }

  const omissions = countOmissions(exchanges, selection, {
    facts: keyFacts.length,
    lists: plan.length + edits.length + commands.length,
  });
  const verbatimReplies = exchanges.filter(
    (exchange, index) =>
      exchange.assistant.length > 0 &&
      selection.reply[index] !== null &&
      selection.replyVerbatim[index],
  ).length;
  const summaryLines = [
    `Thread "${thread.title}" moved from ${describeModel(input.from)} to ${describeModel(input.to)}.`,
    mode === "full"
      ? `Carried the whole conversation (${exchanges.length} exchange${exchanges.length === 1 ? "" : "s"}, ~${conversationTokens.toLocaleString("en-US")} tokens) and ${keyFacts.length} key facts.`
      : `Conversation (~${conversationTokens.toLocaleString("en-US")} tokens) exceeds ${Math.round(HANDOFF_CONTEXT_SHARE * 100)}% of the new model's window; carried ${userTotal - omissions.userClipped - omissions.userOmitted} of your ${userTotal} messages in full${omissions.userClipped > 0 ? `, ${omissions.userClipped} clipped` : ""}, ${verbatimReplies} replies verbatim and ${selection.facts.length} key facts. The new model summarizes the rest itself and can search the full history.`,
  ];
  if (edits.length > 0)
    summaryLines.push(
      `Files touched: ${edits.slice(0, 8).join(", ")}${edits.length > 8 ? ", …" : ""}`,
    );

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

  return {
    mode,
    budgetTokens,
    summary: summaryLines.join("\n"),
    transcript,
    prelude: (transcriptPath) => render(mode, selection, transcriptPath),
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
