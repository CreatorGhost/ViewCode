import {
  DEFAULT_MODEL,
  DEFAULT_MODEL_BY_PROVIDER,
  ProviderDriverKind,
  ProviderInstanceId,
  type AgentSessionHiddenReason,
  type ServerSettings as ServerSettingsValue,
} from "@t3tools/contracts";
import { AGENT_MESSAGE_TAG } from "@t3tools/shared/agentMessages";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as CursorHistory from "./CursorHistory.ts";
import * as T3CodeHistory from "./T3CodeHistory.ts";
import type { AgentSessionThread, AgentSessionRecentThread } from "./AgentSessionScanner.ts";
const MAX_IMPORTED_MESSAGES = 200;
function normalizeTimestamp(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback;
  const parsed = DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : fallback;
}

type CodexSessionOrigin =
  | { readonly kind: "main" }
  | { readonly kind: "child"; readonly parentSessionId: string }
  | { readonly kind: "internal" };

/**
 * Codex writes sub-agent rollouts next to the main ones. Spawned sub-agents
 * name their parent; review, compaction and memory runs are internal work
 * with no conversation of their own. Rollouts spell the key `subagent`, the
 * app-server protocol `subAgent`.
 */
export function codexSessionOrigin(source: unknown): CodexSessionOrigin {
  if (typeof source !== "object" || source === null) return { kind: "main" };
  const record = source as Record<string, unknown>;
  const subAgent = record.subagent ?? record.subAgent ?? record.sub_agent;
  if (subAgent === undefined) return { kind: "main" };
  if (typeof subAgent === "object" && subAgent !== null) {
    const spawn = (subAgent as Record<string, unknown>).thread_spawn;
    if (typeof spawn === "object" && spawn !== null) {
      const parent = (spawn as Record<string, unknown>).parent_thread_id;
      if (typeof parent === "string" && parent.trim().length > 0) {
        return { kind: "child", parentSessionId: parent.trim() };
      }
    }
  }
  return { kind: "internal" };
}

const LEADING_TAG_BLOCK = /^<([A-Za-z_][\w-]*)[^>]*>[\s\S]*?<\/\1>\s*/;
const TRAYCER_AGENT_MESSAGE = "[traycer:agent-message]";

/** Drops leading context blocks a harness injects, optionally stopping at one tag. */
function stripLeadingTagBlocks(text: string, keepTag?: string): string {
  let rest = text.trim();
  for (let match = rest.match(LEADING_TAG_BLOCK); match; match = rest.match(LEADING_TAG_BLOCK)) {
    if (match[1] === keepTag) break;
    rest = rest.slice(match[0].length).trimStart();
  }
  return rest;
}

/**
 * What the person actually typed: the text left after context blocks
 * harnesses inject as user messages (`<environment_context>`, AGENTS.md
 * instructions, plugin lists) and agent-message headers. Null when nothing is.
 */
// The last line of ViewCode's handoff prelude (orchestration/Handoff.ts), sent
// ahead of the user's message on the first turn after a provider switch.
const HANDOFF_TRAILER = "The user's new message follows.";

function userAuthoredText(text: string): string | null {
  const rest = stripLeadingTagBlocks(text);
  if (/^# AGENTS\.md instructions/i.test(rest)) return null;
  const lines = rest
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith(TRAYCER_AGENT_MESSAGE) && line !== HANDOFF_TRAILER,
    );
  if (lines[0] === undefined || lines[0].startsWith("<")) return null;
  return lines.join("\n");
}

/** A title from what the person actually asked. */
export function titleFromUserText(text: string): string | null {
  const authored = userAuthoredText(text);
  if (authored === null) return null;
  return authored.split("\n")[0]?.slice(0, 100).trim() || null;
}

const MIN_VISIBLE_USER_MESSAGES = 2;
const MIN_VISIBLE_USER_CHARACTERS = 200;

/**
 * Decide whether the import picker folds a session away, and count the user
 * messages worth showing. `userTexts` are the session's user messages in
 * order. The first message with content of its own decides whether another
 * agent started the session.
 */
export function classifyAgentSession(input: {
  readonly origin: CodexSessionOrigin["kind"];
  readonly userTexts: ReadonlyArray<string>;
}): { readonly hiddenReason: AgentSessionHiddenReason | null; readonly userMessageCount: number } {
  const authored = input.userTexts.flatMap((text) => {
    const value = userAuthoredText(text);
    return value === null ? [] : [value];
  });
  const userMessageCount = authored.length;
  const hidden = (hiddenReason: AgentSessionHiddenReason) => ({ hiddenReason, userMessageCount });
  if (input.origin === "child") return hidden("subagent");
  if (input.origin === "internal") return hidden("internal");
  for (const text of input.userTexts) {
    const rest = stripLeadingTagBlocks(text, AGENT_MESSAGE_TAG);
    if (rest.startsWith(TRAYCER_AGENT_MESSAGE) || rest.startsWith(`<${AGENT_MESSAGE_TAG}`)) {
      return hidden("agent-message");
    }
    if (userAuthoredText(text) !== null) break;
  }
  if (userMessageCount === 0) return hidden("no-user-text");
  const characters = authored.reduce((total, text) => total + text.length, 0);
  if (userMessageCount < MIN_VISIBLE_USER_MESSAGES && characters < MIN_VISIBLE_USER_CHARACTERS) {
    return hidden("too-short");
  }
  return { hiddenReason: null, userMessageCount };
}

const CLAUDE_SESSION_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The Claude or Codex session a T3 resume cursor names, in the shape the importer binds. */
function t3CodeResume(driver: string, cursor: unknown): AgentSessionThread["resume"] | undefined {
  if (typeof cursor !== "object" || cursor === null) return undefined;
  const record = cursor as Record<string, unknown>;
  const text = (value: unknown) =>
    typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
  if (driver === "codex") {
    const sessionId = text(record.threadId);
    return sessionId === undefined ? undefined : { provider: "codex", sessionId };
  }
  if (driver === "claudeAgent") {
    const sessionId = text(record.resume) ?? text(record.sessionId);
    if (sessionId === undefined || !CLAUDE_SESSION_UUID.test(sessionId)) return undefined;
    const resumeSessionAt = text(record.resumeSessionAt);
    return {
      provider: "claudeAgent",
      sessionId,
      ...(resumeSessionAt === undefined ? {} : { resumeSessionAt }),
    };
  }
  return undefined;
}

/**
 * The messages an imported database thread keeps: all of them, or the first
 * user message and the latest ones. Null when no one ever wrote in it.
 */
function importedMessageWindow<Message extends { readonly role: string }>(
  all: ReadonlyArray<Message>,
): ReadonlyArray<Message> | null {
  const firstUserIndex = all.findIndex((message) => message.role === "user");
  if (firstUserIndex === -1) return null;
  if (all.length <= MAX_IMPORTED_MESSAGES) return all;
  return firstUserIndex >= all.length - (MAX_IMPORTED_MESSAGES - 1)
    ? all.slice(-MAX_IMPORTED_MESSAGES)
    : [all[firstUserIndex]!, ...all.slice(-(MAX_IMPORTED_MESSAGES - 1))];
}

/**
 * A T3 Code thread as an importable session. It continues on the instance T3
 * used when ViewCode has one by that id, else on Codex. T3's saved Claude or
 * Codex session carries over only when it ran on that same instance; other
 * threads continue with a recap (see ProviderCommandReactor).
 */
export function t3CodeThreadToAgentSession(
  thread: T3CodeHistory.T3CodeThread,
  settings: Pick<ServerSettingsValue, "providerInstances">,
): AgentSessionThread | null {
  const driverOf = (instanceId: string | null): ProviderDriverKind | null => {
    if (instanceId === null) return null;
    const configured = settings.providerInstances[ProviderInstanceId.make(instanceId)];
    if (configured !== undefined) return configured.driver;
    const builtIn = ProviderDriverKind.make(instanceId);
    return DEFAULT_MODEL_BY_PROVIDER[builtIn] === undefined ? null : builtIn;
  };
  const t3Driver = driverOf(thread.instanceId);
  const instanceId = t3Driver === null ? "codex" : (thread.instanceId ?? "codex");
  const driver = t3Driver ?? ProviderDriverKind.make("codex");
  const model =
    t3Driver !== null && thread.model !== null
      ? thread.model
      : (DEFAULT_MODEL_BY_PROVIDER[driver] ?? DEFAULT_MODEL);

  const binding = thread.binding;
  const bindingInstanceId =
    binding === null ? null : (binding.providerInstanceId ?? binding.providerName);
  const resume =
    binding !== null && bindingInstanceId === instanceId && binding.providerName === driver
      ? t3CodeResume(driver, binding.resumeCursor)
      : undefined;

  const fallback = normalizeTimestamp(
    thread.updatedAt,
    normalizeTimestamp(thread.createdAt, DateTime.formatIso(DateTime.makeUnsafe(0))),
  );
  const all = thread.messages.map((message) => ({
    ...message,
    createdAt: normalizeTimestamp(message.createdAt, fallback),
  }));
  const messages = importedMessageWindow(all);
  if (messages === null) return null;
  const classification = classifyAgentSession({
    origin: thread.parentThreadId === null ? "main" : "child",
    userTexts: messages.filter((message) => message.role === "user").map((message) => message.text),
  });
  const title =
    thread.title.length > 0
      ? thread.title
      : (all
          .filter((message) => message.role === "user")
          .map((message) => titleFromUserText(message.text))
          .find((candidate) => candidate !== null) ?? "Imported thread");

  return {
    source: "t3code",
    providerInstanceId: ProviderInstanceId.make(instanceId),
    providerSessionId: thread.id,
    title,
    model,
    createdAt: normalizeTimestamp(thread.createdAt, messages[0]?.createdAt ?? fallback),
    updatedAt: fallback,
    messages,
    ...(thread.parentThreadId === null ? {} : { parentProviderSessionId: thread.parentThreadId }),
    userMessageCount: classification.userMessageCount,
    hiddenReason: classification.hiddenReason,
    driver,
    ...(resume === undefined ? {} : { resume }),
  };
}

/**
 * A Cursor chat as an importable session. It continues on the Cursor driver
 * with no resume cursor, so its first turn carries a recap of the imported
 * history (see AgentSessionImporter).
 */
export function cursorThreadToAgentSession(
  thread: CursorHistory.CursorThread,
): AgentSessionThread | null {
  const fallback = normalizeTimestamp(thread.updatedAt, DateTime.formatIso(DateTime.makeUnsafe(0)));
  const all = thread.messages.map((message) => ({
    ...message,
    createdAt: normalizeTimestamp(message.createdAt, fallback),
  }));
  const messages = importedMessageWindow(all);
  if (messages === null) return null;
  const userTexts = all.filter((message) => message.role === "user").map((message) => message.text);
  const classification = classifyAgentSession({
    origin: "main",
    userTexts: messages.filter((message) => message.role === "user").map((message) => message.text),
  });
  // "New Agent" is the name Cursor gives every chat it never titled.
  const cursorTitle = thread.title?.trim();
  const title =
    (cursorTitle && cursorTitle.toLowerCase() !== "new agent" ? cursorTitle : null) ??
    userTexts.map(titleFromUserText).find((candidate) => candidate !== null) ??
    "Imported thread";
  return {
    source: "cursor",
    providerInstanceId: ProviderInstanceId.make("cursor"),
    providerSessionId: thread.id,
    title,
    model: null,
    createdAt: normalizeTimestamp(thread.createdAt, messages[0]?.createdAt ?? fallback),
    updatedAt: fallback,
    messages,
    userMessageCount: classification.userMessageCount,
    // A single prompt is mostly a one-off Cursor CLI command, not a conversation.
    hiddenReason:
      classification.hiddenReason ?? (classification.userMessageCount <= 1 ? "too-short" : null),
    driver: ProviderDriverKind.make("cursor"),
  };
}

export interface ExternalCandidate {
  readonly cwd: string;
  readonly source: "cursor" | "t3code";
  readonly providerInstanceId: ProviderInstanceId;
  readonly threadCount: number;
  readonly lastActiveAtMs: number | null;
  readonly transcripts: readonly [];
  readonly externalProjectId?: string;
}
export const make = Effect.gen(function* () {
  const cursor = yield* Effect.serviceOption(CursorHistory.CursorHistory);
  const t3 = yield* Effect.serviceOption(T3CodeHistory.T3CodeHistory);
  // A missing reader skips its source without an error, so say so once here.
  // The span files the warnings in server.trace.ndjson: the trace logger only
  // records messages logged inside one.
  yield* Effect.gen(function* () {
    if (Option.isNone(cursor)) {
      yield* Effect.logWarning(
        "Cursor history reader is not wired; Cursor chats won't appear in Import past sessions",
      );
    }
    if (Option.isNone(t3)) {
      yield* Effect.logWarning(
        "T3 Code history reader is not wired; T3 Code chats won't appear in Import past sessions",
      );
    }
  }).pipe(
    Effect.withSpan("ViewCodeSessionSources.make", {
      attributes: {
        "viewcode.history.cursor": Option.isSome(cursor),
        "viewcode.history.t3code": Option.isSome(t3),
      },
    }),
  );
  const discover = Effect.fn("ViewCodeSessionSources.discover")(function* (sinceMs: number) {
    const candidates: ExternalCandidate[] = [];
    const warnings: string[] = [];
    if (Option.isSome(cursor)) {
      const read = yield* cursor.value.projects(sinceMs);
      const warning = CursorHistory.cursorReadWarning(read);
      if (warning !== null) warnings.push(warning);
      if (read._tag === "Read")
        for (const project of read.value)
          candidates.push({
            cwd: project.workspaceRoot,
            source: "cursor",
            providerInstanceId: ProviderInstanceId.make("cursor"),
            threadCount: project.threadCount,
            lastActiveAtMs: project.lastActiveAt === null ? null : Date.parse(project.lastActiveAt),
            transcripts: [],
          });
    }
    if (Option.isSome(t3)) {
      const read = yield* t3.value.projects;
      const warning = T3CodeHistory.t3CodeReadWarning(read);
      if (warning !== null) warnings.push(warning);
      if (read._tag === "Read")
        for (const project of read.value)
          candidates.push({
            cwd: project.workspaceRoot,
            source: "t3code",
            providerInstanceId: ProviderInstanceId.make("t3code"),
            externalProjectId: project.id,
            threadCount: project.threadCount,
            lastActiveAtMs: project.lastActiveAt === null ? null : Date.parse(project.lastActiveAt),
            transcripts: [],
          });
    }
    return { candidates, warnings };
  });
  const recent = Effect.fn("ViewCodeSessionSources.recent")(function* (
    candidates: ReadonlyArray<{
      readonly cwd: string;
      readonly source: string;
      readonly externalProjectId?: string;
    }>,
    sinceMs: number,
    settings: Pick<ServerSettingsValue, "providerInstances">,
  ) {
    const outcomes: AgentSessionRecentThread[] = [];
    const append = (thread: AgentSessionThread | null, filePath: string) => {
      if (thread === null) return;
      outcomes.push({
        _tag: "Importable",
        thread,
        source: {
          provider: thread.source,
          providerInstanceId: thread.providerInstanceId,
          providerSessionId: thread.providerSessionId,
          filePath,
          size: 0,
          mtimeMs: null,
          device: 0,
          inode: null,
          birthtimeMs: null,
        },
      });
    };
    const roots = candidates.filter((c) => c.source === "cursor").map((c) => c.cwd);
    if (Option.isSome(cursor) && roots.length > 0) {
      const read = yield* cursor.value.threads(roots, sinceMs);
      const warning = CursorHistory.cursorReadWarning(read);
      if (warning !== null) outcomes.push({ _tag: "Warning", message: warning });
      if (read._tag === "Read")
        for (const thread of read.value)
          append(cursorThreadToAgentSession(thread), thread.sourcePath);
    }
    const ids = candidates
      .filter((c) => c.source === "t3code")
      .flatMap((c) => (c.externalProjectId === undefined ? [] : [c.externalProjectId]));
    if (Option.isSome(t3) && ids.length > 0) {
      const read = yield* t3.value.threads(ids);
      const warning = T3CodeHistory.t3CodeReadWarning(read);
      if (warning !== null) outcomes.push({ _tag: "Warning", message: warning });
      if (read._tag === "Read")
        for (const thread of read.value)
          append(t3CodeThreadToAgentSession(thread, settings), read.databasePath);
    }
    return outcomes;
  });

  return { discover, recent };
});
