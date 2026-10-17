// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeSqlite from "node:sqlite";
import type { T3CodeRead, T3CodeProject, T3CodeThread } from "./T3CodeHistory.ts";

const object = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown) => typeof value === "string" ? value : "";
const nullable = (value: unknown) => text(value).trim() || null;
function json(value: unknown): Record<string, unknown> {
  try { return object(typeof value === "string" ? JSON.parse(value) : value); } catch { return {}; }
}

/** A read-only transaction supports current upstream without touching the source database. */
function read<A>(databasePath: string, use: (db: NodeSqlite.DatabaseSync) => A): T3CodeRead<A> | null {
  if (!NodeFS.existsSync(databasePath)) return { _tag: "NotFound" };
  let db: NodeSqlite.DatabaseSync | undefined;
  try {
    db = new NodeSqlite.DatabaseSync(databasePath, { readOnly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='orchestration_v2_projection_threads'").get();
    if (table === undefined) return null;
    db.exec("BEGIN");
    const value = use(db);
    db.exec("COMMIT");
    return { _tag: "Read", databasePath, value };
  } catch (cause) {
    return { _tag: "Unreadable", detail: cause instanceof Error ? cause.message : String(cause) };
  } finally { db?.close(); }
}

export function projects(databasePath: string): T3CodeRead<ReadonlyArray<T3CodeProject>> | null {
  return read(databasePath, (db) => db.prepare(`
    SELECT p.project_id, p.title, p.workspace_root, count(t.thread_id) AS thread_count, max(t.updated_at) AS last_active_at
    FROM projection_projects p LEFT JOIN orchestration_v2_projection_threads t ON t.project_id=p.project_id AND t.deleted_at IS NULL
      AND EXISTS(SELECT 1 FROM orchestration_v2_projection_messages m WHERE m.thread_id=t.thread_id AND m.role IN ('user','assistant'))
    WHERE p.deleted_at IS NULL GROUP BY p.project_id
  `).all().flatMap((row) => nullable(row.workspace_root) === null ? [] : [{
    id:text(row.project_id), title:text(row.title), workspaceRoot:text(row.workspace_root), threadCount:Number(row.thread_count ?? 0), lastActiveAt:nullable(row.last_active_at),
  }]));
}

export function threads(databasePath: string, projectIds: ReadonlyArray<string>): T3CodeRead<ReadonlyArray<T3CodeThread>> | null {
  return read(databasePath, (db) => {
    const runtimeExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='provider_session_runtime'").get() !== undefined;
    const rows = db.prepare(`SELECT thread_id, project_id, title, created_at, updated_at, payload_json FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL AND project_id IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC LIMIT 1000`).all(JSON.stringify(projectIds));
    let remainingBytes = 32 * 1024 * 1024;
    return rows.flatMap((row): T3CodeThread[] => {
      const payload = json(row.payload_json);
      const selection = object(payload.modelSelection);
      const messages = db.prepare(`SELECT message_id, role, created_at, payload_json FROM (
        SELECT message_id, role, created_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role IN ('user','assistant') ORDER BY created_at DESC, message_id DESC LIMIT 199
      ) UNION SELECT message_id, role, created_at, payload_json FROM (
        SELECT message_id, role, created_at, payload_json FROM orchestration_v2_projection_messages WHERE thread_id=? AND role='user' ORDER BY created_at,message_id LIMIT 1
      ) ORDER BY created_at, message_id`).all(text(row.thread_id),text(row.thread_id)).flatMap((message): T3CodeThread["messages"][number][] => {
        const data = json(message.payload_json);
        const attachments = Array.isArray(data.attachments) ? data.attachments.length : 0;
        const note = attachments === 0 ? "" : `\n\n[${attachments} attachment${attachments === 1 ? " was" : "s were"} not imported from T3 Code]`;
        const body = `${text(data.text)}${note}`.trim();
        const bytes = Buffer.byteLength(body);
        if (body.length === 0 || bytes > remainingBytes) return [];
        remainingBytes -= bytes;
        return [{role:message.role === "user" ? "user" : "assistant",text:body,createdAt:text(message.created_at)}];
      });
      if (!messages.some((message) => message.role === "user")) return [];
      const runtime = runtimeExists ? db.prepare("SELECT provider_name, provider_instance_id, resume_cursor_json FROM provider_session_runtime WHERE thread_id=?").get(text(row.thread_id)) : undefined;
      return [{
        id:text(row.thread_id),projectId:text(row.project_id),title:text(row.title),instanceId:nullable(selection.instanceId) ?? nullable(payload.providerInstanceId),model:nullable(selection.model),createdAt:text(row.created_at),updatedAt:text(row.updated_at),
        parentThreadId:nullable(object(payload.lineage).parentThreadId),messages,
        binding:runtime === undefined ? null : {providerName:text(runtime.provider_name),providerInstanceId:nullable(runtime.provider_instance_id),resumeCursor:json(runtime.resume_cursor_json)},
      }];
    });
  });
}
