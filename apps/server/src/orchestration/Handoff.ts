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
  readonly assistant: string;
}

const MAX_RECENT_CHARS = 12_000;
const MAX_ANSWER_CHARS = 1_500;
const MAX_LIST_ITEMS = 25;

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
      if (current)
        exchanges.push({ user: current.user, assistant: current.assistant.join("\n\n") });
      current = { user: message.text, assistant: [] };
    } else if (message.role === "assistant" && message.text.trim().length > 0) {
      if (!current) current = { user: "", assistant: [] };
      current.assistant.push(message.text);
    }
  }
  if (current) exchanges.push({ user: current.user, assistant: current.assistant.join("\n\n") });
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

export function buildHandoff(input: {
  readonly thread: OrchestrationThread;
  readonly from: HandoffEndpoint;
  readonly to: HandoffEndpoint;
  readonly recentExchanges: number;
}): HandoffDocument {
  const { thread } = input;
  const exchanges = exchangesOf(thread);
  const firstAsk = exchanges.find((exchange) => exchange.user.trim().length > 0)?.user ?? "";
  const { edits, commands } = toolWork(thread);
  const plan = latestPlan(thread);

  const recent: Exchange[] = [];
  let budget = MAX_RECENT_CHARS;
  for (
    let index = exchanges.length - 1;
    index >= 0 && recent.length < input.recentExchanges;
    index -= 1
  ) {
    const exchange = exchanges[index]!;
    const size = exchange.user.length + exchange.assistant.length;
    if (recent.length > 0 && size > budget) break;
    budget -= size;
    recent.unshift(exchange);
  }
  const earlier = exchanges.slice(0, exchanges.length - recent.length);

  const summaryLines = [
    `Thread "${thread.title}" moved from ${describeModel(input.from)} to ${describeModel(input.to)}.`,
    `${exchanges.length} earlier exchange${exchanges.length === 1 ? "" : "s"}; ${recent.length} carried verbatim.`,
  ];
  if (edits.length > 0)
    summaryLines.push(
      `Files touched: ${edits.slice(0, 8).join(", ")}${edits.length > 8 ? ", …" : ""}`,
    );
  if (plan.length > 0)
    summaryLines.push(
      `Open plan steps: ${plan.filter((step) => !step.startsWith("[completed]")).length}`,
    );

  const recap: string[] = [];
  if (firstAsk) recap.push(`## Original request\n${clip(firstAsk, 2_000)}`);
  if (earlier.length > 0) {
    recap.push(
      `## Earlier exchanges (condensed)\n${earlier
        .map((exchange, index) => {
          const ask = clip(exchange.user, 300) || "(no user message)";
          const answer = clip(exchange.assistant, MAX_ANSWER_CHARS) || "(no reply)";
          return `${index + 1}. User: ${ask}\n   Assistant: ${answer.replace(/\n/g, "\n   ")}`;
        })
        .join("\n")}`,
    );
  }
  if (edits.length > 0)
    recap.push(`## Files changed so far\n${edits.map((path) => `- ${path}`).join("\n")}`);
  if (commands.length > 0)
    recap.push(`## Commands run\n${commands.map((command) => `- ${command}`).join("\n")}`);
  if (plan.length > 0) recap.push(`## Plan / todos\n${plan.map((step) => `- ${step}`).join("\n")}`);
  if (recent.length > 0) {
    recap.push(
      `## Most recent exchanges (verbatim)\n${recent
        .map(
          (exchange) =>
            `### User\n${exchange.user.trim()}\n\n### Assistant\n${exchange.assistant.trim()}`,
        )
        .join("\n\n")}`,
    );
  }

  const transcript = [
    `# Transcript: ${thread.title}`,
    "",
    ...thread.messages.map(
      (message) => `## ${message.role} · ${message.createdAt}\n\n${message.text.trim()}\n`,
    ),
  ].join("\n");

  return {
    summary: summaryLines.join("\n"),
    transcript,
    prelude: (transcriptPath) =>
      [
        "<handoff>",
        `You are continuing an existing conversation. It was previously handled by ${describeModel(input.from)}; you (${describeModel(input.to)}) are taking over with no access to that model's session.`,
        "Treat everything below as shared context you already know. Do not repeat finished work; continue from where it left off.",
        transcriptPath
          ? `The full transcript is at ${transcriptPath} — read it only if you need details not included here.`
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
