// node:sqlite reads Cursor's stores synchronously, like T3CodeHistory.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * CursorHistory - projects and chats from Cursor on this machine, offered
 * through the same scan → pick → import flow as Claude Code and Codex session
 * files (see AgentSessionScanner).
 *
 * Cursor keeps two unrelated stores, both read here:
 *
 *  - The CLI (`cursor-agent`): `<chatsDir>/<md5 of project path>/<chatId>/` with
 *    `meta.json` and a SQLite `store.db`. The store's `meta` row `0` is hex
 *    JSON naming a root blob; the root is a protobuf whose field 1 entries are
 *    the ids of the message blobs, in order. Message blobs are JSON.
 *  - The editor: `state.vscdb` in globalStorage holds `composerHeaders` (which
 *    workspace each chat belongs to) and `cursorDiskKV` rows
 *    `composerData:<id>` and `bubbleId:<id>:<bubble>`.
 *    `workspaceStorage/<id>/workspace.json` maps a workspace id to its folder.
 *
 * Both are Cursor's private formats and change often, and Cursor may be
 * running and writing. Every database is only ever attached with `mode=ro` in
 * a private in-memory database and read inside one read transaction; editor
 * stores can be hundreds of MB, so only the rows of the chats asked for are
 * touched. Nothing is written to Cursor's files. A store whose shape is not the
 * one expected reads as `Unsupported` and surfaces as a warning instead of
 * failing. The per-chat encryption key in the CLI's `meta` row is never read
 * into the result or logged.
 *
 * @module project/CursorHistory
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

export const CURSOR_UNSUPPORTED_WARNING =
  "This Cursor version isn't supported, so its chats were skipped.";
export const CURSOR_UNREADABLE_WARNING = "Could not read Cursor's chats, so they were skipped.";

export interface CursorProject {
  readonly workspaceRoot: string;
  /** Chats updated inside the requested window. */
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}

export interface CursorThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface CursorThread {
  /** CLI chats use the chat id; editor chats `editor:<composerId>`. */
  readonly id: string;
  readonly workspaceRoot: string;
  /** Cursor's own name for the chat, when it has one. */
  readonly title: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** User and assistant messages, oldest first. */
  readonly messages: ReadonlyArray<CursorThreadMessage>;
  /** The file the chat was read from. */
  readonly sourcePath: string;
}

export type CursorRead<A> =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unsupported"; readonly detail: string }
  | { readonly _tag: "Unreadable"; readonly detail: string }
  /** `warning` is set when one of the two stores could not be read but the other could. */
  | { readonly _tag: "Read"; readonly value: A; readonly warning: string | null };

/** Human-readable reason a read produced nothing or only part, or null when it did not fail. */
export function cursorReadWarning(read: CursorRead<unknown>): string | null {
  if (read._tag === "Unsupported") return CURSOR_UNSUPPORTED_WARNING;
  if (read._tag === "Unreadable") return CURSOR_UNREADABLE_WARNING;
  if (read._tag === "Read") return read.warning;
  return null;
}

export interface CursorPaths {
  /** `~/.cursor/chats`. */
  readonly chatsDir: string;
  /** The editor's `User` directory, or null where the editor store is not read. */
  readonly editorUserDir: string | null;
}

class UnsupportedStore extends Error {}

type Part<A> = Exclude<CursorRead<A>, { readonly _tag: "Read" }> | { _tag: "Read"; value: A };

const text = (value: unknown) => (typeof value === "string" ? value : "");
const nullableText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

function parseJson(value: unknown): unknown {
  try {
    if (typeof value === "string") return JSON.parse(value);
    if (value instanceof Uint8Array) return JSON.parse(Buffer.from(value).toString("utf8"));
  } catch {
    // Not JSON; callers treat null as unreadable.
  }
  return null;
}

/** Epoch milliseconds from a number, numeric string or ISO string. */
function toMillis(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value === "string" && value.trim().length > 0) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return numeric > 0 ? numeric : null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/** Cursor stores no per-message times on the CLI side: spread the messages over the chat's span. */
const spreadTime = (createdMs: number, updatedMs: number, index: number, count: number) =>
  createdMs + (count < 2 ? 0 : Math.round(((updatedMs - createdMs) * index) / (count - 1)));

const isDirectory = (path: string) => {
  try {
    return NodeFS.statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/** A read-only view of a SQLite file for the length of `read`. */
function withReadOnlySource<A>(databasePath: string, read: (db: NodeSqlite.DatabaseSync) => A): A {
  const db = new NodeSqlite.DatabaseSync(":memory:");
  try {
    // A running Cursor may hold a lock briefly; wait a little rather than fail.
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("ATTACH DATABASE ? AS src").run(
      `${NodeURL.pathToFileURL(databasePath).href}?mode=ro`,
    );
    db.exec("BEGIN");
    try {
      return read(db);
    } finally {
      db.exec("ROLLBACK");
    }
  } finally {
    db.close();
  }
}

function requireColumns(db: NodeSqlite.DatabaseSync, table: string, required: string[]) {
  const present = new Set(
    db
      .prepare(`PRAGMA src.table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
  const missing = required.filter((column) => !present.has(column));
  if (missing.length > 0) throw new UnsupportedStore(`${table} is missing ${missing.join(", ")}`);
  return present;
}

function failure(cause: unknown): Part<never> {
  if (cause instanceof UnsupportedStore) return { _tag: "Unsupported", detail: cause.message };
  return { _tag: "Unreadable", detail: cause instanceof Error ? cause.message : String(cause) };
}

/** Merge the CLI and editor reads: either one succeeding is a result, the other's failure a warning. */
function combine<A>(parts: ReadonlyArray<Part<ReadonlyArray<A>>>): CursorRead<ReadonlyArray<A>> {
  const reads = parts.flatMap((part) => (part._tag === "Read" ? part.value : []));
  const failed = parts.filter((part) => part._tag === "Unsupported" || part._tag === "Unreadable");
  const worst = failed.find((part) => part._tag === "Unsupported") ?? failed[0];
  if (parts.some((part) => part._tag === "Read")) {
    return {
      _tag: "Read",
      value: reads,
      warning: worst === undefined ? null : cursorReadWarning(worst),
    };
  }
  return worst ?? { _tag: "NotFound" };
}

// ---------------------------------------------------------------------------
// CLI store
// ---------------------------------------------------------------------------

interface CliChat {
  readonly id: string;
  readonly workspaceRoot: string;
  readonly title: string | null;
  readonly createdMs: number;
  readonly updatedMs: number;
  readonly storePath: string;
}

/** CLI chats updated since `sinceMs`, from `meta.json` alone: no store is opened. */
function listCliChats(chatsDir: string, sinceMs: number): Array<CliChat> {
  const chats: Array<CliChat> = [];
  for (const projectHash of NodeFS.readdirSync(chatsDir)) {
    const projectDir = NodePath.join(chatsDir, projectHash);
    if (!isDirectory(projectDir)) continue;
    for (const chatId of NodeFS.readdirSync(projectDir)) {
      const chatDir = NodePath.join(projectDir, chatId);
      const storePath = NodePath.join(chatDir, "store.db");
      if (!NodeFS.existsSync(storePath)) continue;
      let meta: Record<string, unknown>;
      try {
        meta = asRecord(
          JSON.parse(NodeFS.readFileSync(NodePath.join(chatDir, "meta.json"), "utf8")),
        );
      } catch {
        continue;
      }
      const workspaceRoot = nullableText(meta.cwd);
      // Sub-agent chats and chats with no folder cannot be placed in a project.
      if (workspaceRoot === null || meta.isSubagent === true || meta.hasConversation === false) {
        continue;
      }
      const updatedMs = toMillis(meta.updatedAtMs) ?? toMillis(meta.createdAtMs);
      if (updatedMs === null || updatedMs < sinceMs) continue;
      chats.push({
        id: chatId,
        workspaceRoot,
        title: nullableText(meta.title),
        createdMs: toMillis(meta.createdAtMs) ?? updatedMs,
        updatedMs,
        storePath,
      });
    }
  }
  return chats;
}

/** Hex-encoded JSON (the CLI's spelling), or plain JSON. */
function decodeMetaValue(value: unknown): Record<string, unknown> {
  const raw = value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : text(value);
  const trimmed = raw.trim();
  const json = /^(?:[0-9a-f]{2})+$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex").toString("utf8")
    : trimmed;
  return asRecord(parseJson(json));
}

function readVarint(buffer: Uint8Array, start: number): [value: number, next: number] {
  let value = 0;
  let multiplier = 1;
  let index = start;
  for (;;) {
    const byte = buffer[index++];
    if (byte === undefined) throw new RangeError("truncated varint");
    value += (byte & 0x7f) * multiplier;
    if (byte < 0x80) return [value, index];
    multiplier *= 128;
  }
}

/** Field 1 (length-delimited, 32 bytes) entries of the root blob: message blob ids, in order. */
export function readRootMessageIds(root: Uint8Array): Array<string> {
  const ids: Array<string> = [];
  let index = 0;
  try {
    while (index < root.length) {
      const [key, afterKey] = readVarint(root, index);
      index = afterKey;
      const wire = key % 8;
      if (wire === 0) index = readVarint(root, index)[1];
      else if (wire === 1) index += 8;
      else if (wire === 5) index += 4;
      else if (wire === 2) {
        const [length, afterLength] = readVarint(root, index);
        if (key >>> 3 === 1 && length === 32 && afterLength + length <= root.length) {
          ids.push(Buffer.from(root.subarray(afterLength, afterLength + length)).toString("hex"));
        }
        index = afterLength + length;
      } else break;
    }
  } catch {
    // A malformed tail keeps the ids found before it.
  }
  return ids;
}

const USER_QUERY = /<user_query>([\s\S]*?)<\/user_query>/;

/** A CLI message as chat text, or null for tool results, injected context and empty turns. */
function cliMessage(blob: unknown): { role: "user" | "assistant"; text: string } | null {
  const record = asRecord(blob);
  const body = (
    typeof record.content === "string"
      ? [record.content]
      : Array.isArray(record.content)
        ? record.content.flatMap((part) => {
            const entry = asRecord(part);
            return entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [];
          })
        : []
  ).join("\n");
  if (record.role === "user") {
    // Only the prompt the person typed; `<user_info>` and similar are injected.
    const query = USER_QUERY.exec(body)?.[1]?.trim();
    return query ? { role: "user", text: query } : null;
  }
  if (record.role === "assistant") {
    const reply = body.trim();
    return reply.length === 0 ? null : { role: "assistant", text: reply };
  }
  return null;
}

/** Message blobs larger than this are tool output, never chat text. */
const MAX_MESSAGE_BLOB_BYTES = 8 * 1024 * 1024;

function readCliThread(chat: CliChat): CursorThread | null {
  return withReadOnlySource(chat.storePath, (db) => {
    requireColumns(db, "meta", ["key", "value"]);
    requireColumns(db, "blobs", ["id", "data"]);
    const metaRow = db.prepare("SELECT value FROM src.meta WHERE key = '0'").get();
    if (metaRow === undefined) return null;
    const head = decodeMetaValue(metaRow.value);
    const rootId = nullableText(head.latestRootBlobId);
    if (rootId === null) return null;
    const root = db.prepare("SELECT data FROM src.blobs WHERE id = ?").get(rootId)?.data;
    if (!(root instanceof Uint8Array)) return null;

    const blob = db.prepare("SELECT data FROM src.blobs WHERE id = ? AND length(data) <= ?");
    const parsed = readRootMessageIds(root).flatMap((messageId) => {
      const message = cliMessage(parseJson(blob.get(messageId, MAX_MESSAGE_BLOB_BYTES)?.data));
      return message === null ? [] : [message];
    });
    if (!parsed.some((message) => message.role === "user")) return null;
    return {
      id: chat.id,
      workspaceRoot: chat.workspaceRoot,
      title: nullableText(head.name) ?? chat.title,
      createdAt: iso(chat.createdMs),
      updatedAt: iso(chat.updatedMs),
      messages: parsed.map((message, index) => ({
        ...message,
        createdAt: iso(spreadTime(chat.createdMs, chat.updatedMs, index, parsed.length)),
      })),
      sourcePath: chat.storePath,
    };
  });
}

function cliProjects(paths: CursorPaths, sinceMs: number): Part<ReadonlyArray<CursorProject>> {
  if (!isDirectory(paths.chatsDir)) return { _tag: "NotFound" };
  try {
    return { _tag: "Read", value: groupProjects(listCliChats(paths.chatsDir, sinceMs)) };
  } catch (cause) {
    return failure(cause);
  }
}

function cliThreads(
  paths: CursorPaths,
  roots: ReadonlySet<string>,
  sinceMs: number,
): Part<ReadonlyArray<CursorThread>> {
  if (!isDirectory(paths.chatsDir)) return { _tag: "NotFound" };
  try {
    const threads: Array<CursorThread> = [];
    const failed: Array<Part<never>> = [];
    for (const chat of listCliChats(paths.chatsDir, sinceMs)) {
      if (!roots.has(chat.workspaceRoot)) continue;
      try {
        const thread = readCliThread(chat);
        if (thread !== null) threads.push(thread);
      } catch (cause) {
        // One broken chat store does not hide the rest.
        failed.push(failure(cause));
      }
    }
    // Every chat failing is a format we do not understand, not a bad chat.
    if (threads.length === 0 && failed.length > 0) {
      return failed.find((part) => part._tag === "Unsupported") ?? failed[0]!;
    }
    return { _tag: "Read", value: threads };
  } catch (cause) {
    return failure(cause);
  }
}

// ---------------------------------------------------------------------------
// Editor store
// ---------------------------------------------------------------------------

/** Workspace storage id → folder path, from each `workspace.json`. Several ids may share a folder. */
function readWorkspaceFolders(userDir: string): Map<string, string> {
  const folders = new Map<string, string>();
  const storageDir = NodePath.join(userDir, "workspaceStorage");
  if (!isDirectory(storageDir)) return folders;
  for (const id of NodeFS.readdirSync(storageDir)) {
    try {
      const folder = asRecord(
        JSON.parse(NodeFS.readFileSync(NodePath.join(storageDir, id, "workspace.json"), "utf8")),
      ).folder;
      // Remote (`vscode-remote:`) folders are not on this machine.
      if (typeof folder === "string" && folder.startsWith("file:")) {
        folders.set(id, NodeURL.fileURLToPath(folder));
      }
    } catch {
      // A workspace without a readable folder is not one we can place.
    }
  }
  return folders;
}

interface EditorChat {
  readonly composerId: string;
  readonly workspaceRoot: string;
  readonly title: string | null;
  readonly createdMs: number;
  readonly updatedMs: number;
  /** Present when messages were asked for. */
  readonly messages: ReadonlyArray<CursorThreadMessage> | null;
}

/**
 * Editor chats of the workspaces in `roots` (all when null) updated since
 * `sinceMs`, with messages when `withMessages`. Archived and sub-agent chats
 * and chats the person never wrote in are left out.
 */
function readEditorChats(
  userDir: string,
  roots: ReadonlySet<string> | null,
  sinceMs: number,
  withMessages: boolean,
): Array<EditorChat> {
  const folders = readWorkspaceFolders(userDir);
  return withReadOnlySource(editorStorePath(userDir), (db) => {
    const headerColumns = requireColumns(db, "composerHeaders", [
      "composerId",
      "workspaceId",
      "createdAt",
      "lastUpdatedAt",
    ]);
    requireColumns(db, "cursorDiskKV", ["key", "value"]);
    const filters = ["isArchived", "isSubagent"]
      .filter((column) => headerColumns.has(column))
      .map((column) => `COALESCE(${column}, 0) = 0`);
    const headers = db
      .prepare(
        `SELECT composerId, workspaceId, createdAt, lastUpdatedAt FROM src.composerHeaders${
          filters.length > 0 ? ` WHERE ${filters.join(" AND ")}` : ""
        }`,
      )
      .all();
    const value = db.prepare("SELECT value FROM src.cursorDiskKV WHERE key = ?");

    const chats: Array<EditorChat> = [];
    for (const header of headers) {
      const workspaceRoot = folders.get(text(header.workspaceId));
      const composerId = nullableText(header.composerId);
      if (workspaceRoot === undefined || composerId === null) continue;
      if (roots !== null && !roots.has(workspaceRoot)) continue;
      const data = asRecord(parseJson(value.get(`composerData:${composerId}`)?.value));
      const updatedMs = toMillis(header.lastUpdatedAt) ?? toMillis(data.lastUpdatedAt);
      if (updatedMs === null || updatedMs < sinceMs) continue;
      const createdMs = toMillis(header.createdAt) ?? toMillis(data.createdAt) ?? updatedMs;
      // Conversation order, with Cursor's bubble type (1 user, 2 assistant).
      const bubbles = (
        Array.isArray(data.fullConversationHeadersOnly) ? data.fullConversationHeadersOnly : []
      ).flatMap((entry) => {
        const record = asRecord(entry);
        const id = nullableText(record.bubbleId);
        return id === null ? [] : [{ id, type: Number(record.type) }];
      });
      // Headers carry the bubble type, so "never wrote in" needs no bubble reads.
      if (!bubbles.some((bubble) => bubble.type === 1)) continue;

      let messages: Array<CursorThreadMessage> | null = null;
      if (withMessages) {
        const parsed = bubbles.flatMap((bubble) => {
          if (bubble.type !== 1 && bubble.type !== 2) return [];
          const record = asRecord(
            parseJson(value.get(`bubbleId:${composerId}:${bubble.id}`)?.value),
          );
          const body = text(record.text).trim();
          if (body.length === 0) return [];
          return [
            {
              role: bubble.type === 1 ? ("user" as const) : ("assistant" as const),
              text: body,
              atMs: toMillis(record.createdAt),
            },
          ];
        });
        if (!parsed.some((message) => message.role === "user")) continue;
        messages = parsed.map((message, index) => ({
          role: message.role,
          text: message.text,
          createdAt: iso(message.atMs ?? spreadTime(createdMs, updatedMs, index, parsed.length)),
        }));
      }
      chats.push({
        composerId,
        workspaceRoot,
        title: nullableText(data.name),
        createdMs,
        updatedMs,
        messages,
      });
    }
    return chats;
  });
}

const editorStorePath = (userDir: string) => NodePath.join(userDir, "globalStorage", "state.vscdb");

function readEditor<A>(paths: CursorPaths, read: (userDir: string) => A): Part<A> {
  const userDir = paths.editorUserDir;
  if (userDir === null || !NodeFS.existsSync(editorStorePath(userDir))) return { _tag: "NotFound" };
  try {
    return { _tag: "Read", value: read(userDir) };
  } catch (cause) {
    return failure(cause);
  }
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

function groupProjects(
  chats: ReadonlyArray<{ readonly workspaceRoot: string; readonly updatedMs: number }>,
): Array<CursorProject> {
  const byRoot = new Map<string, { count: number; lastMs: number }>();
  for (const chat of chats) {
    const entry = byRoot.get(chat.workspaceRoot) ?? { count: 0, lastMs: 0 };
    entry.count += 1;
    entry.lastMs = Math.max(entry.lastMs, chat.updatedMs);
    byRoot.set(chat.workspaceRoot, entry);
  }
  return [...byRoot].map(([workspaceRoot, entry]) => ({
    workspaceRoot,
    threadCount: entry.count,
    lastActiveAt: iso(entry.lastMs),
  }));
}

/** Folders with Cursor chats updated since `sinceMs`, from the CLI and the editor. */
export function readCursorProjects(
  paths: CursorPaths,
  sinceMs: number,
): CursorRead<ReadonlyArray<CursorProject>> {
  const read = combine([
    cliProjects(paths, sinceMs),
    readEditor(paths, (userDir) => groupProjects(readEditorChats(userDir, null, sinceMs, false))),
  ]);
  if (read._tag !== "Read") return read;
  // A folder both stores know about is one project.
  const merged = new Map<string, { count: number; lastMs: number }>();
  for (const project of read.value) {
    const entry = merged.get(project.workspaceRoot) ?? { count: 0, lastMs: 0 };
    entry.count += project.threadCount;
    entry.lastMs = Math.max(entry.lastMs, Date.parse(project.lastActiveAt ?? "") || 0);
    merged.set(project.workspaceRoot, entry);
  }
  return {
    ...read,
    value: [...merged].map(([workspaceRoot, entry]) => ({
      workspaceRoot,
      threadCount: entry.count,
      lastActiveAt: entry.lastMs > 0 ? iso(entry.lastMs) : null,
    })),
  };
}

/** Chats of the given folders updated since `sinceMs`, with their messages. */
export function readCursorThreads(
  paths: CursorPaths,
  workspaceRoots: ReadonlyArray<string>,
  sinceMs: number,
): CursorRead<ReadonlyArray<CursorThread>> {
  const roots = new Set(workspaceRoots);
  return combine([
    cliThreads(paths, roots, sinceMs),
    readEditor(paths, (userDir) =>
      readEditorChats(userDir, roots, sinceMs, true).flatMap((chat): Array<CursorThread> =>
        chat.messages === null
          ? []
          : [
              {
                id: `editor:${chat.composerId}`,
                workspaceRoot: chat.workspaceRoot,
                title: chat.title,
                createdAt: iso(chat.createdMs),
                updatedAt: iso(chat.updatedMs),
                messages: chat.messages,
                sourcePath: editorStorePath(userDir),
              },
            ],
      ),
    ),
  ]);
}

/** Service tag: the Cursor stores this server may import from, if any. */
export class CursorHistory extends Context.Service<
  CursorHistory,
  {
    readonly projects: (sinceMs: number) => Effect.Effect<CursorRead<ReadonlyArray<CursorProject>>>;
    readonly threads: (
      workspaceRoots: ReadonlyArray<string>,
      sinceMs: number,
    ) => Effect.Effect<CursorRead<ReadonlyArray<CursorThread>>>;
  }
>()("t3/project/CursorHistory") {}

/** Reads the Cursor stores at explicit paths (tests, or a relocated home). */
export const layerFromPaths = (paths: CursorPaths) =>
  Layer.succeed(CursorHistory, {
    projects: (sinceMs) => Effect.sync(() => readCursorProjects(paths, sinceMs)),
    threads: (workspaceRoots, sinceMs) =>
      Effect.sync(() => readCursorThreads(paths, workspaceRoots, sinceMs)),
  });

/** The editor's `User` directory where VS Code-family apps keep it on each platform. */
export function cursorEditorUserDir(
  platform: NodeJS.Platform,
  home: string,
  env: { readonly APPDATA?: string | undefined; readonly XDG_CONFIG_HOME?: string | undefined },
): string | null {
  if (platform === "darwin") {
    return NodePath.join(home, "Library", "Application Support", "Cursor", "User");
  }
  if (platform === "win32") {
    return NodePath.win32.join(
      env.APPDATA || NodePath.win32.join(home, "AppData", "Roaming"),
      "Cursor",
      "User",
    );
  }
  if (platform === "linux") {
    return NodePath.join(env.XDG_CONFIG_HOME || NodePath.join(home, ".config"), "Cursor", "User");
  }
  return null;
}

/** `~/.cursor/chats`, plus the editor's `User` directory for this platform. */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const platform = yield* HostProcessPlatform;
    const home = NodeOS.homedir();
    return layerFromPaths({
      chatsDir: NodePath.join(home, ".cursor", "chats"),
      editorUserDir: cursorEditorUserDir(platform, home, process.env),
    });
  }),
);
