// node:sqlite snapshots a live T3 Code database synchronously, like usage/opencodeUsageReader.
// @effect-diagnostics nodeBuiltinImport:off
/**
 * T3CodeHistory - projects and threads from a T3 Code install on this machine,
 * offered through the same scan → pick → import flow as Claude Code and Codex
 * session files (see AgentSessionScanner).
 *
 * T3 Code may be running and writing while this reads. Its database is only
 * ever attached with `mode=ro`: the rows needed are copied, inside one read
 * transaction, into a private temp database, which is read and then deleted.
 * Nothing is ever written to the T3 file, and T3's writer is only held off
 * checkpointing for the length of the copy.
 *
 * T3 Code shares this repository's schema lineage, so table and column names
 * come from `persistence/Migrations`. A database missing any required table or
 * column reads as `Unsupported` instead of failing.
 *
 * @module project/T3CodeHistory
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";

export const T3_CODE_UNSUPPORTED_WARNING =
  "This T3 Code version isn't supported, so its projects and conversations were skipped.";
export const T3_CODE_UNREADABLE_WARNING =
  "Could not read T3 Code's database, so its projects and conversations were skipped.";

export interface T3CodeProject {
  readonly id: string;
  readonly title: string;
  readonly workspaceRoot: string;
  /** Active threads with at least one user or assistant message. */
  readonly threadCount: number;
  readonly lastActiveAt: string | null;
}

export interface T3CodeThreadMessage {
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
}

export interface T3CodeThread {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  /** T3's instance id (or, before instances existed, its provider name). */
  readonly instanceId: string | null;
  readonly model: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly parentThreadId: string | null;
  /** User and assistant messages, oldest first. */
  readonly messages: ReadonlyArray<T3CodeThreadMessage>;
  /** T3's saved provider session, if the thread ever ran one. */
  readonly binding: {
    readonly providerName: string;
    readonly providerInstanceId: string | null;
    readonly resumeCursor: unknown;
  } | null;
}

export type T3CodeRead<A> =
  | { readonly _tag: "NotFound" }
  | { readonly _tag: "Unsupported"; readonly detail: string }
  | { readonly _tag: "Unreadable"; readonly detail: string }
  | { readonly _tag: "Read"; readonly databasePath: string; readonly value: A };

/** Human-readable reason a read produced nothing, or null when it did not fail. */
export function t3CodeReadWarning(read: T3CodeRead<unknown>): string | null {
  if (read._tag === "Unsupported") return T3_CODE_UNSUPPORTED_WARNING;
  if (read._tag === "Unreadable") return T3_CODE_UNREADABLE_WARNING;
  return null;
}

interface T3Schema {
  readonly modelColumn: "model_selection_json" | "model";
  readonly hasAttachments: boolean;
  readonly hasParentThread: boolean;
  readonly runtime: { readonly hasInstanceId: boolean } | null;
}

const REQUIRED_COLUMNS: Record<string, ReadonlyArray<string>> = {
  projection_projects: ["project_id", "title", "workspace_root", "deleted_at"],
  projection_threads: [
    "thread_id",
    "project_id",
    "title",
    "created_at",
    "updated_at",
    "deleted_at",
  ],
  projection_thread_messages: ["message_id", "thread_id", "role", "text", "created_at"],
};

class UnsupportedSchema extends Error {}

function columnsOf(db: NodeSqlite.DatabaseSync, table: string): Set<string> {
  return new Set(
    db
      .prepare(`PRAGMA t3.table_info(${table})`)
      .all()
      .map((row) => String(row.name)),
  );
}

function readSchema(db: NodeSqlite.DatabaseSync): T3Schema {
  const tables = new Set(
    db
      .prepare("SELECT name FROM t3.sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name)),
  );
  const columns = new Map<string, Set<string>>();
  for (const [table, required] of Object.entries(REQUIRED_COLUMNS)) {
    if (!tables.has(table)) throw new UnsupportedSchema(`missing table ${table}`);
    const present = columnsOf(db, table);
    const missing = required.filter((column) => !present.has(column));
    if (missing.length > 0) {
      throw new UnsupportedSchema(`${table} is missing ${missing.join(", ")}`);
    }
    columns.set(table, present);
  }
  const threadColumns = columns.get("projection_threads") ?? new Set<string>();
  // Migration 016 replaced `model` with `model_selection_json`.
  const modelColumn = threadColumns.has("model_selection_json")
    ? "model_selection_json"
    : threadColumns.has("model")
      ? "model"
      : null;
  if (modelColumn === null) throw new UnsupportedSchema("projection_threads has no model column");
  const runtimeColumns = tables.has("provider_session_runtime")
    ? columnsOf(db, "provider_session_runtime")
    : null;
  return {
    modelColumn,
    hasAttachments: columns.get("projection_thread_messages")?.has("attachments_json") === true,
    hasParentThread: threadColumns.has("parent_thread_id"),
    runtime:
      runtimeColumns !== null &&
      ["thread_id", "provider_name", "resume_cursor_json"].every((column) =>
        runtimeColumns.has(column),
      )
        ? { hasInstanceId: runtimeColumns.has("provider_instance_id") }
        : null,
  };
}

/**
 * Copy what `copy` selects from the T3 database into a temp database in one
 * read transaction, detach the source, then read the copy. The temp directory
 * is removed whatever happens.
 */
function withSnapshot<A>(
  databasePath: string,
  copy: (db: NodeSqlite.DatabaseSync, schema: T3Schema) => void,
  read: (db: NodeSqlite.DatabaseSync, schema: T3Schema) => A,
): T3CodeRead<A> {
  if (!NodeFS.existsSync(databasePath)) return { _tag: "NotFound" };
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-t3-import-"));
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(NodePath.join(directory, "snapshot.sqlite"));
    // T3's writer may hold a lock briefly; wait a little rather than fail.
    db.exec("PRAGMA busy_timeout = 2000");
    db.prepare("ATTACH DATABASE ? AS t3").run(
      `${NodeURL.pathToFileURL(databasePath).href}?mode=ro`,
    );
    const schema = readSchema(db);
    db.exec("BEGIN");
    try {
      copy(db, schema);
      db.exec("COMMIT");
    } catch (cause) {
      db.exec("ROLLBACK");
      throw cause;
    }
    db.exec("DETACH DATABASE t3");
    return { _tag: "Read", databasePath, value: read(db, schema) };
  } catch (cause) {
    if (cause instanceof UnsupportedSchema) return { _tag: "Unsupported", detail: cause.message };
    return { _tag: "Unreadable", detail: cause instanceof Error ? cause.message : String(cause) };
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed or never opened.
    }
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");
const nullableText = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value : null;

/** Active T3 projects with their importable thread counts. */
export function readT3CodeProjects(databasePath: string): T3CodeRead<ReadonlyArray<T3CodeProject>> {
  return withSnapshot(
    databasePath,
    (db) => {
      db.exec(`
        CREATE TABLE projects AS
        SELECT
          p.project_id AS id,
          p.title AS title,
          p.workspace_root AS workspace_root,
          COUNT(t.thread_id) AS thread_count,
          MAX(t.updated_at) AS last_active_at
        FROM t3.projection_projects p
        LEFT JOIN t3.projection_threads t
          ON t.project_id = p.project_id
          AND t.deleted_at IS NULL
          AND EXISTS (
            SELECT 1 FROM t3.projection_thread_messages m
            WHERE m.thread_id = t.thread_id AND m.role IN ('user', 'assistant')
          )
        WHERE p.deleted_at IS NULL
        GROUP BY p.project_id
      `);
    },
    (db) =>
      db
        .prepare("SELECT id, title, workspace_root, thread_count, last_active_at FROM projects")
        .all()
        .flatMap((row) => {
          const workspaceRoot = nullableText(row.workspace_root);
          if (workspaceRoot === null) return [];
          return [
            {
              id: text(row.id),
              title: text(row.title),
              workspaceRoot,
              threadCount: Number(row.thread_count ?? 0),
              lastActiveAt: nullableText(row.last_active_at),
            },
          ];
        }),
  );
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function attachmentNote(attachmentsJson: unknown): string | null {
  const attachments = parseJson(attachmentsJson);
  if (!Array.isArray(attachments) || attachments.length === 0) return null;
  return attachments.length === 1
    ? "[1 attachment was not imported from T3 Code]"
    : `[${attachments.length} attachments were not imported from T3 Code]`;
}

/** Active threads of the given T3 projects, with their messages and saved provider session. */
export function readT3CodeThreads(
  databasePath: string,
  projectIds: ReadonlyArray<string>,
): T3CodeRead<ReadonlyArray<T3CodeThread>> {
  return withSnapshot(
    databasePath,
    (db, schema) => {
      db.prepare(
        `
        CREATE TABLE threads AS
        SELECT
          thread_id AS id,
          project_id AS project_id,
          title AS title,
          ${schema.modelColumn} AS model,
          created_at AS created_at,
          updated_at AS updated_at,
          ${schema.hasParentThread ? "parent_thread_id" : "NULL"} AS parent_thread_id
        FROM t3.projection_threads
        WHERE deleted_at IS NULL
          AND project_id IN (SELECT value FROM json_each(?))
      `,
      ).run(JSON.stringify(projectIds));
      db.exec(`
        CREATE TABLE messages AS
        SELECT
          m.rowid AS seq,
          m.thread_id AS thread_id,
          m.role AS role,
          m.text AS text,
          m.created_at AS created_at,
          ${schema.hasAttachments ? "m.attachments_json" : "NULL"} AS attachments_json
        FROM t3.projection_thread_messages m
        WHERE m.thread_id IN (SELECT id FROM main.threads)
          AND m.role IN ('user', 'assistant')
      `);
      if (schema.runtime !== null) {
        db.exec(`
          CREATE TABLE bindings AS
          SELECT
            thread_id AS thread_id,
            provider_name AS provider_name,
            ${schema.runtime.hasInstanceId ? "provider_instance_id" : "NULL"} AS provider_instance_id,
            resume_cursor_json AS resume_cursor_json
          FROM t3.provider_session_runtime
          WHERE thread_id IN (SELECT id FROM main.threads)
        `);
      }
    },
    (db, schema) => {
      const messagesByThread = new Map<string, Array<T3CodeThreadMessage>>();
      for (const row of db
        .prepare(
          "SELECT thread_id, role, text, created_at, attachments_json FROM messages ORDER BY created_at, seq",
        )
        .iterate()) {
        const note = attachmentNote(row.attachments_json);
        const body = text(row.text).trim();
        const messageText = note === null ? body : body.length === 0 ? note : `${body}\n\n${note}`;
        if (messageText.length === 0) continue;
        const threadId = text(row.thread_id);
        const messages = messagesByThread.get(threadId) ?? [];
        messages.push({
          role: row.role === "user" ? "user" : "assistant",
          text: messageText,
          createdAt: text(row.created_at),
        });
        messagesByThread.set(threadId, messages);
      }
      const bindings = new Map<string, NonNullable<T3CodeThread["binding"]>>();
      if (schema.runtime !== null) {
        for (const row of db
          .prepare(
            "SELECT thread_id, provider_name, provider_instance_id, resume_cursor_json FROM bindings",
          )
          .all()) {
          const providerName = nullableText(row.provider_name);
          if (providerName === null) continue;
          bindings.set(text(row.thread_id), {
            providerName,
            providerInstanceId: nullableText(row.provider_instance_id),
            resumeCursor: parseJson(row.resume_cursor_json),
          });
        }
      }
      return db
        .prepare(
          "SELECT id, project_id, title, model, created_at, updated_at, parent_thread_id FROM threads",
        )
        .all()
        .flatMap((row): Array<T3CodeThread> => {
          const id = text(row.id);
          const messages = messagesByThread.get(id);
          if (messages === undefined || messages.length === 0) return [];
          const selection =
            schema.modelColumn === "model" ? { model: row.model } : parseJson(row.model);
          const record =
            typeof selection === "object" && selection !== null
              ? (selection as Record<string, unknown>)
              : {};
          return [
            {
              id,
              projectId: text(row.project_id),
              title: text(row.title).trim(),
              instanceId: nullableText(record.instanceId) ?? nullableText(record.provider),
              model: nullableText(record.model),
              createdAt: text(row.created_at),
              updatedAt: text(row.updated_at),
              parentThreadId: nullableText(row.parent_thread_id),
              messages,
              binding: bindings.get(id) ?? null,
            },
          ];
        });
    },
  );
}

/** Service tag: the T3 Code database this server may import from, if any. */
export class T3CodeHistory extends Context.Service<
  T3CodeHistory,
  {
    readonly projects: Effect.Effect<T3CodeRead<ReadonlyArray<T3CodeProject>>>;
    readonly threads: (
      projectIds: ReadonlyArray<string>,
    ) => Effect.Effect<T3CodeRead<ReadonlyArray<T3CodeThread>>>;
  }
>()("t3/project/T3CodeHistory") {}

/** Reads the first of `databasePaths` that exists. */
export const layerFromDatabasePaths = (databasePaths: ReadonlyArray<string>) =>
  Layer.succeed(T3CodeHistory, {
    projects: Effect.sync(() => {
      const databasePath = databasePaths.find((candidate) => NodeFS.existsSync(candidate));
      return databasePath === undefined
        ? ({ _tag: "NotFound" } as const)
        : readT3CodeProjects(databasePath);
    }),
    threads: (projectIds) =>
      Effect.sync(() => {
        const databasePath = databasePaths.find((candidate) => NodeFS.existsSync(candidate));
        return databasePath === undefined
          ? ({ _tag: "NotFound" } as const)
          : readT3CodeThreads(databasePath, projectIds);
      }),
  });

/**
 * T3 Code's default home, `~/.t3`: its installed app's `userdata`, then a
 * development server's `dev`. `T3CODE_HOME` is not consulted because ViewCode
 * reads that variable for its own home. A path that is this server's own
 * database is never offered.
 */
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const home = NodeOS.homedir();
    const own = NodePath.resolve(dbPath);
    return layerFromDatabasePaths(
      [
        NodePath.join(home, ".t3", "userdata", "state.sqlite"),
        NodePath.join(home, ".t3", "dev", "state.sqlite"),
      ].filter((candidate) => NodePath.resolve(candidate) !== own),
    );
  }),
);
