// Fixture T3 Code databases are built and hashed with Node's own fs and sqlite.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import {
  makeSqlitePersistenceLive,
  SqlitePersistenceMemory,
} from "../persistence/Layers/Sqlite.ts";
import * as ProviderSessionRuntime from "../persistence/ProviderSessionRuntime.ts";
import { OrchestrationEngineLive } from "../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../orchestration/Layers/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../orchestration/ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../orchestration/ThreadPlanProgress.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectoryLive } from "../provider/Layers/ProviderSessionDirectory.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";
import { importRecentAgentThreads, listImportableAgentSessions } from "./AgentSessionImporter.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";
import * as T3CodeHistory from "./T3CodeHistory.ts";

const FIXTURE_DIR = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-t3-import-test-"));
const WORKSPACE = NodePath.join(FIXTURE_DIR, "workspace");
const OTHER_WORKSPACE = NodePath.join(FIXTURE_DIR, "other-workspace");
const T3_DB = NodePath.join(FIXTURE_DIR, "t3", "userdata", "state.sqlite");
const CLAUDE_SESSION = "123e4567-e89b-42d3-a456-426614174000";
NodeFS.mkdirSync(WORKSPACE, { recursive: true });
NodeFS.mkdirSync(OTHER_WORKSPACE, { recursive: true });

afterAll(() => NodeFS.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

const encodeJson = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** A T3 Code database built with this repository's migrations (T3's schema lineage). */
const buildT3Database = (databasePath: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const project = (id: string, root: string, deletedAt: string | null = null) => sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
      VALUES (${id}, ${id}, ${root}, '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ${deletedAt})
    `;
    const thread = (
      id: string,
      title: string,
      modelSelection: object,
      updatedAt: string,
      deletedAt: string | null = null,
    ) => sql`
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, deleted_at)
      VALUES (${id}, 'p-main', ${title}, ${encodeJson(modelSelection)}, '2026-02-01T00:00:00.000Z', ${updatedAt}, ${deletedAt})
    `;
    const message = (
      id: string,
      threadId: string,
      role: string,
      text: string,
      createdAt: string,
      attachments: unknown[] | null = null,
    ) => sql`
      INSERT INTO projection_thread_messages (message_id, thread_id, role, text, is_streaming, created_at, updated_at, attachments_json)
      VALUES (${id}, ${threadId}, ${role}, ${text}, 0, ${createdAt}, ${createdAt}, ${attachments === null ? null : encodeJson(attachments)})
    `;
    yield* project("p-main", WORKSPACE);
    yield* project("p-empty", OTHER_WORKSPACE);
    yield* project("p-deleted", WORKSPACE, "2026-03-01T00:00:00.000Z");
    yield* thread(
      "t-claude",
      "Fix the login bug",
      { instanceId: "claudeAgent", model: "claude-opus-4-6" },
      "2026-02-03T00:00:00.000Z",
    );
    yield* thread(
      "t-cursor",
      "Refactor the router",
      { instanceId: "cursor", model: "auto" },
      "2026-02-02T00:00:00.000Z",
    );
    yield* thread(
      "t-deleted",
      "Deleted thread",
      { instanceId: "codex", model: "gpt-5" },
      "2026-02-04T00:00:00.000Z",
      "2026-02-05T00:00:00.000Z",
    );
    yield* thread(
      "t-empty",
      "Never used",
      { instanceId: "codex", model: "gpt-5" },
      "2026-02-06T00:00:00.000Z",
    );
    // Inserted out of order: the snapshot reads by time.
    yield* message(
      "m2",
      "t-claude",
      "assistant",
      "The session cookie expired early.",
      "2026-02-01T00:01:00.000Z",
    );
    yield* message("m1", "t-claude", "user", "Why does login fail?", "2026-02-01T00:00:00.000Z", [
      { type: "image", id: "a1", name: "screen.png", mimeType: "image/png", sizeBytes: 10 },
    ]);
    yield* message("m3", "t-claude", "system", "internal", "2026-02-01T00:02:00.000Z");
    yield* message(
      "m4",
      "t-claude",
      "user",
      "Please fix it and add a test for the expiry.",
      "2026-02-01T00:03:00.000Z",
    );
    yield* message(
      "m5",
      "t-cursor",
      "user",
      "Split the router into modules, one per resource, and keep the public API the same.",
      "2026-02-01T00:00:00.000Z",
    );
    yield* message("m6", "t-deleted", "user", "gone", "2026-02-01T00:00:00.000Z");
    yield* sql`
      INSERT INTO provider_session_runtime (thread_id, provider_name, provider_instance_id, adapter_key, status, last_seen_at, resume_cursor_json)
      VALUES ('t-claude', 'claudeAgent', 'claudeAgent', 'claudeAgent', 'stopped', '2026-02-03T00:00:00.000Z',
        ${encodeJson({ threadId: "t-claude", resume: CLAUDE_SESSION, resumeSessionAt: "msg-uuid", turnCount: 2 })})
    `;
  }).pipe(
    // Fresh: inside a test layer the migration layer is already memoized
    // against the in-memory database and would not run on this file.
    Effect.provide(
      Layer.fresh(makeSqlitePersistenceLive(databasePath).pipe(Layer.provide(NodeServices.layer))),
    ),
  );

it.layer(NodeServices.layer)("T3CodeHistory", (it) => {
  it.effect("reads active projects and threads from a snapshot without touching the file", () =>
    Effect.gen(function* () {
      const databasePath = NodePath.join(FIXTURE_DIR, "read", "state.sqlite");
      yield* buildT3Database(databasePath);
      const before = sha256(databasePath);

      const projects = T3CodeHistory.readT3CodeProjects(databasePath);
      const threads = T3CodeHistory.readT3CodeThreads(databasePath, ["p-main"]);

      expect(projects._tag).toBe("Read");
      expect(projects._tag === "Read" ? projects.value : []).toEqual(
        expect.arrayContaining([
          {
            id: "p-main",
            title: "p-main",
            workspaceRoot: WORKSPACE,
            threadCount: 2,
            lastActiveAt: "2026-02-03T00:00:00.000Z",
          },
          {
            id: "p-empty",
            title: "p-empty",
            workspaceRoot: OTHER_WORKSPACE,
            threadCount: 0,
            lastActiveAt: null,
          },
        ]),
      );
      expect(projects._tag === "Read" ? projects.value.length : 0).toBe(2);

      expect(threads._tag).toBe("Read");
      const byId = new Map(
        (threads._tag === "Read" ? threads.value : []).map((thread) => [thread.id, thread]),
      );
      expect([...byId.keys()].toSorted()).toEqual(["t-claude", "t-cursor"]);
      expect(byId.get("t-claude")).toMatchObject({
        title: "Fix the login bug",
        instanceId: "claudeAgent",
        model: "claude-opus-4-6",
        messages: [
          {
            role: "user",
            text: "Why does login fail?\n\n[1 attachment was not imported from T3 Code]",
          },
          { role: "assistant", text: "The session cookie expired early." },
          { role: "user", text: "Please fix it and add a test for the expiry." },
        ],
        binding: {
          providerName: "claudeAgent",
          providerInstanceId: "claudeAgent",
          resumeCursor: { threadId: "t-claude", resume: CLAUDE_SESSION },
        },
      });
      expect(byId.get("t-cursor")?.binding).toBeNull();

      expect(sha256(databasePath)).toBe(before);
    }),
  );

  it("reports a database without the tables it needs as unsupported", () => {
    const databasePath = NodePath.join(FIXTURE_DIR, "old", "state.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(databasePath), { recursive: true });
    const db = new NodeSqlite.DatabaseSync(databasePath);
    db.exec("CREATE TABLE projection_projects (project_id TEXT, title TEXT, workspace_root TEXT)");
    db.close();

    const projects = T3CodeHistory.readT3CodeProjects(databasePath);
    expect(projects._tag).toBe("Unsupported");
    expect(T3CodeHistory.t3CodeReadWarning(projects)).toBe(
      T3CodeHistory.T3_CODE_UNSUPPORTED_WARNING,
    );
    expect(T3CodeHistory.readT3CodeThreads(databasePath, ["p"])._tag).toBe("Unsupported");
    expect(T3CodeHistory.readT3CodeProjects(`${databasePath}.missing`)._tag).toBe("NotFound");
  });
});

const runtimeRepository = ProviderSessionRuntime.layer.pipe(Layer.provide(SqlitePersistenceMemory));
const integrationLayer = Layer.mergeAll(
  OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(OrchestrationProjectionPipelineLive),
  ),
  OrchestrationProjectionSnapshotQueryLive,
  ProviderSessionDirectoryLive.pipe(Layer.provide(runtimeRepository)),
  AgentSessionScanner.layer.pipe(
    Layer.provide(T3CodeHistory.layerFromDatabasePaths([T3_DB])),
    Layer.provide(OrchestrationProjectionSnapshotQueryLive),
    // Claude and Codex are off so the scan never reads this machine's homes.
    Layer.provide(
      ServerSettings.layerTest({
        providers: { claudeAgent: { enabled: false }, codex: { enabled: false } },
      }),
    ),
  ),
).pipe(
  Layer.provide(ThreadBackgroundLiveness.layer),
  Layer.provide(ThreadPlanProgress.layer),
  Layer.provide(OrchestrationEventStoreLive),
  Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  Layer.provide(RepositoryIdentityResolver.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "viewcode-t3-import-config-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(integrationLayer)("T3 Code import", (it) => {
  it.effect("scans, lists and imports T3 Code threads once, reading the database only", () =>
    Effect.gen(function* () {
      yield* buildT3Database(T3_DB);
      const before = sha256(T3_DB);
      const scanner = yield* AgentSessionScanner.AgentSessionScanner;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

      const scan = yield* scanner.scan;
      expect(scan.warning).toBeUndefined();
      expect(scan.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: WORKSPACE, sources: ["t3code"], threadCount: 2 }),
          expect.objectContaining({ path: OTHER_WORKSPACE, sources: ["t3code"], threadCount: 0 }),
        ]),
      );

      const projectId = ProjectId.make("project-from-t3");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-project-from-t3"),
        projectId,
        title: "workspace",
        workspaceRoot: WORKSPACE,
        defaultModelSelection: null,
        createdAt: "2026-03-01T00:00:00.000Z",
      });

      const listed = yield* listImportableAgentSessions({ projectId });
      expect(
        listed.sessions.map((session) => ({
          id: session.providerSessionId,
          provider: session.provider,
          instance: session.providerInstanceId,
          title: session.title,
          model: session.model,
          alreadyImported: session.alreadyImported,
        })),
      ).toEqual([
        {
          id: "t-claude",
          provider: "t3code",
          instance: "claudeAgent",
          title: "Fix the login bug",
          model: "claude-opus-4-6",
          alreadyImported: false,
        },
        {
          id: "t-cursor",
          provider: "t3code",
          instance: "cursor",
          title: "Refactor the router",
          model: "auto",
          alreadyImported: false,
        },
      ]);

      const selection = listed.sessions.map(({ providerInstanceId, providerSessionId }) => ({
        providerInstanceId,
        providerSessionId,
      }));
      const imported = yield* importRecentAgentThreads({ projectId, sessions: selection });
      expect(imported).toEqual({ importedCount: 2, skippedCount: 0 });

      const claudeThreadId = ThreadId.make("import:t3code:t-claude");
      const claudeThread = Option.getOrThrow(yield* snapshots.getThreadDetailById(claudeThreadId));
      expect(claudeThread).toMatchObject({
        projectId,
        title: "Fix the login bug",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-4-6" },
      });
      expect(
        claudeThread.messages.map((message) => [message.role, message.text, message.createdAt]),
      ).toEqual([
        [
          "user",
          "Why does login fail?\n\n[1 attachment was not imported from T3 Code]",
          "2026-02-01T00:00:00.000Z",
        ],
        ["assistant", "The session cookie expired early.", "2026-02-01T00:01:00.000Z"],
        ["user", "Please fix it and add a test for the expiry.", "2026-02-01T00:03:00.000Z"],
      ]);
      // T3's Claude session carries over, so the next message resumes it natively.
      expect(Option.getOrThrow(yield* directory.getBinding(claudeThreadId))).toMatchObject({
        provider: "claudeAgent",
        providerInstanceId: "claudeAgent",
        resumeCursor: {
          threadId: claudeThreadId,
          resume: CLAUDE_SESSION,
          resumeSessionAt: "msg-uuid",
        },
      });
      // A thread with no carried session continues with a recap instead.
      expect(
        Option.getOrThrow(yield* directory.getBinding(ThreadId.make("import:t3code:t-cursor")))
          .resumeCursor,
      ).toBeNull();

      const sequence = yield* engine.latestSequence;
      const again = yield* importRecentAgentThreads({ projectId, sessions: selection });
      expect(again.skippedCount).toBe(0);
      expect(yield* engine.latestSequence).toBe(sequence);
      const relisted = yield* listImportableAgentSessions({ projectId });
      expect(relisted.sessions.every((session) => session.alreadyImported)).toBe(true);

      expect(sha256(T3_DB)).toBe(before);
    }),
  );
});
