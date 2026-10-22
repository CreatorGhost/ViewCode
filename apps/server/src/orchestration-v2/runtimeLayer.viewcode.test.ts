// Fixture Cursor and T3 Code stores are written with Node's own fs and sqlite.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, expect, it } from "@effect/vitest";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { EventId, ProjectId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AgentSessionImporter from "../project/AgentSessionImporter.ts";
import * as CursorHistory from "../project/CursorHistory.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as T3CodeHistory from "../project/T3CodeHistory.ts";
import * as CursorFixtures from "../project/testkit/CursorHistoryFixtures.ts";
import * as ViewCodeAgentSessionScanner from "../project/ViewCodeAgentSessionScanner.ts";
import * as WorktreeSetupTracker from "../project/WorktreeSetupTracker.ts";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const FIXTURE_DIR = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-runtime-import-"));
const WORKSPACE = NodePath.join(FIXTURE_DIR, "workspace");
const CHATS_DIR = NodePath.join(FIXTURE_DIR, "cursor", "chats");
const T3_DB = NodePath.join(FIXTURE_DIR, "t3", "userdata", "state.sqlite");
NodeFS.mkdirSync(WORKSPACE, { recursive: true });
afterAll(() => NodeFS.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;
// Fixtures sit after the test clock's 0, inside the recency window. Moving the
// clock forward instead would replay every runtime worker's schedule.
const NOW = 1_781_000_000_000;

CursorFixtures.writeCliChat({
  chatsDir: CHATS_DIR,
  hash: "guard",
  id: "chat-guard",
  name: "Cursor guard chat",
  meta: {
    schemaVersion: 1,
    createdAtMs: NOW - 2 * DAY,
    updatedAtMs: NOW - 2 * DAY + 60_000,
    hasConversation: true,
    cwd: WORKSPACE,
  },
  messages: [
    CursorFixtures.userPrompt("Why is the build slow?"),
    { role: "assistant", content: "The cache is cold." },
    CursorFixtures.userPrompt("Warm it in CI."),
  ],
});

{
  NodeFS.mkdirSync(NodePath.dirname(T3_DB), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(T3_DB);
  db.exec(`
    CREATE TABLE projection_projects(project_id TEXT,title TEXT,workspace_root TEXT,scripts_json TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE projection_threads(thread_id TEXT,project_id TEXT,title TEXT,model_selection_json TEXT,created_at TEXT,updated_at TEXT,deleted_at TEXT);
    CREATE TABLE projection_thread_messages(message_id TEXT,thread_id TEXT,role TEXT,text TEXT,is_streaming INTEGER,created_at TEXT,updated_at TEXT,attachments_json TEXT);
    CREATE TABLE provider_session_runtime(thread_id TEXT,provider_name TEXT,provider_instance_id TEXT,adapter_key TEXT,status TEXT,last_seen_at TEXT,resume_cursor_json TEXT);
  `);
  db.prepare(
    "INSERT INTO projection_projects VALUES ('p-guard', 'guard', ?, '[]', ?, ?, NULL)",
  ).run(WORKSPACE, "2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
  db.exec(`
    INSERT INTO projection_threads VALUES ('t-guard', 'p-guard', 'T3 guard thread', '{"instanceId":"codex","model":"gpt-5"}', '2026-02-01T00:00:00.000Z', '2026-02-02T00:00:00.000Z', NULL);
    INSERT INTO projection_thread_messages VALUES ('m1', 't-guard', 'user', 'Split the router into modules and keep the public API exactly the same as it is today.', 0, '2026-02-01T00:00:00.000Z', '2026-02-01T00:00:00.000Z', NULL);
    INSERT INTO projection_thread_messages VALUES ('m2', 't-guard', 'user', 'Then add tests for each module.', 0, '2026-02-01T00:01:00.000Z', '2026-02-01T00:01:00.000Z', NULL);
  `);
  db.close();
}

const layerFixtureScanner = ViewCodeAgentSessionScanner.layerFromReaders.pipe(
  Layer.provide(
    Layer.merge(
      CursorHistory.layerFromPaths({ chatsDir: CHATS_DIR, editorUserDir: null }),
      T3CodeHistory.layerFromDatabasePaths([T3_DB]),
    ),
  ),
);

// The production runtime, given its scanner from outside as server.ts does, with
// its other server-side dependencies stubbed. If runtimeLayer.ts builds its own
// scanner again, that one has no readers and lists neither source.
const layerTest = RuntimeLayer.layerProduction.pipe(
  Layer.provide(layerFixtureScanner),
  Layer.provideMerge(ProjectStore.layer),
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(CheckpointStore.CheckpointStore)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(GitWorkflow.GitWorkflowService)({ pruneWorktrees: () => Effect.void }),
      Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({}),
      Layer.mock(ProjectEnrichmentService.ProjectEnrichmentService)({
        getAvailable: () =>
          Effect.succeed({
            repositoryIdentity: null,
            faviconPath: null,
            repositoryIdentityResolved: false,
          }),
      }),
      Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
        getInstance: () => Effect.succeed(undefined),
        listInstances: Effect.succeed([]),
        listUnavailable: Effect.succeed([]),
        streamChanges: Stream.empty,
        subscribeChanges: Effect.never,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({}),
      Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
        resolveLink: () => Effect.die("unused"),
      }),
      Layer.mock(TerminalManager.TerminalManager)({}),
      Layer.mock(TextGeneration.TextGeneration)({}),
      Layer.mock(WorkspacePaths.WorkspacePaths)({
        normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
      }),
      Layer.mock(WorktreeSetupTracker.WorktreeSetupTracker)({}),
    ),
  ),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  // Claude Code and Codex stay off so the scanner never reads this machine's homes.
  Layer.provide(
    ServerSettings.layerTest({
      providerInstances: {
        [ProviderInstanceId.make("claudeAgent")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
        },
        [ProviderInstanceId.make("codex")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
        },
      },
    }),
  ),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "viewcode-runtime-import-" })),
  Layer.provide(NodeServices.layer),
);

it.layer(layerTest)("v2 runtime session import", (it) => {
  it.effect("lists Cursor and T3 Code sessions through the composition root's scanner", () =>
    Effect.gen(function* () {
      const projectId = ProjectId.make("project-guard");
      const projects = yield* ProjectStore.ProjectStoreV2;
      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make("seed:project-guard"),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-03-01T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "guard",
          workspaceRoot: WORKSPACE,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-03-01T00:00:00.000Z",
          updatedAt: "2026-03-01T00:00:00.000Z",
        },
      });

      const importer = yield* AgentSessionImporter.AgentSessionImporter;
      const listed = yield* importer.listImportableAgentSessions({ projectId });
      expect(listed.warning).toBeUndefined();
      expect(
        listed.sessions.map((session) => [session.provider, session.providerSessionId]).toSorted(),
      ).toEqual([
        ["cursor", "chat-guard"],
        ["t3code", "t-guard"],
      ]);
    }),
  );
});
