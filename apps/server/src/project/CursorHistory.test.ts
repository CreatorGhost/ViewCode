// Fixture Cursor stores are built and hashed with Node's own fs, crypto and sqlite.
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, expect, it } from "@effect/vitest";
import { CommandId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
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
import * as CursorHistory from "./CursorHistory.ts";
import * as RepositoryIdentityResolver from "./RepositoryIdentityResolver.ts";

const FIXTURE_DIR = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-cursor-test-"));
const WORKSPACE = NodePath.join(FIXTURE_DIR, "workspace");
const OTHER_WORKSPACE = NodePath.join(FIXTURE_DIR, "other-workspace");
const CHATS_DIR = NodePath.join(FIXTURE_DIR, "chats");
const EDITOR_DIR = NodePath.join(FIXTURE_DIR, "editor", "User");
const EDITOR_DB = NodePath.join(EDITOR_DIR, "globalStorage", "state.vscdb");
NodeFS.mkdirSync(WORKSPACE, { recursive: true });
NodeFS.mkdirSync(OTHER_WORKSPACE, { recursive: true });

afterAll(() => NodeFS.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_781_000_000_000;
const SINCE = NOW - 30 * DAY;
const paths: CursorHistory.CursorPaths = { chatsDir: CHATS_DIR, editorUserDir: EDITOR_DIR };

const sha256 = (file: string) =>
  NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(file)).digest("hex");

/** A root blob: other fields around field 1 entries holding the message blob ids. */
const rootBlob = (messageIds: ReadonlyArray<string>) =>
  Buffer.concat([
    Buffer.from([0x10, 0x05]),
    ...messageIds.flatMap((id) => [Buffer.from([0x0a, 0x20]), Buffer.from(id, "hex")]),
    Buffer.from([0x1a, 0x03, 1, 2, 3]),
    Buffer.from([0x25, 0, 0, 0, 0]),
  ]);

interface CliChatOptions {
  readonly hash: string;
  readonly id: string;
  readonly meta: Record<string, unknown>;
  readonly name?: string;
  readonly messages?: ReadonlyArray<unknown>;
  readonly skipStore?: boolean;
  readonly storeSchema?: string;
  readonly chatsDir?: string;
}

const buildCliChat = (options: CliChatOptions) => {
  const dir = NodePath.join(options.chatsDir ?? CHATS_DIR, options.hash, options.id);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "meta.json"), JSON.stringify(options.meta));
  if (options.skipStore === true) return;
  const db = new NodeSqlite.DatabaseSync(NodePath.join(dir, "store.db"));
  db.exec(
    options.storeSchema ??
      "CREATE TABLE meta (key TEXT, value TEXT); CREATE TABLE blobs (id TEXT, data BLOB)",
  );
  if (options.storeSchema === undefined) {
    const insert = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    const ids = (options.messages ?? []).map((message) => {
      const data = Buffer.from(JSON.stringify(message));
      const id = NodeCrypto.createHash("sha256").update(data).digest("hex");
      insert.run(id, data);
      return id;
    });
    const root = rootBlob(ids);
    const rootId = NodeCrypto.createHash("sha256").update(root).digest("hex");
    insert.run(rootId, root);
    db.prepare("INSERT INTO meta (key, value) VALUES ('0', ?)").run(
      Buffer.from(
        JSON.stringify({
          agentId: options.id,
          latestRootBlobId: rootId,
          name: options.name ?? "",
          lastUsedModel: "composer-2",
          blobEncryptionKey: "SECRET-KEY-MATERIAL",
        }),
      ).toString("hex"),
    );
  }
  db.close();
};

const cliMeta = (extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  createdAtMs: NOW - 2 * DAY,
  updatedAtMs: NOW - 2 * DAY + 60_000,
  hasConversation: true,
  cwd: WORKSPACE,
  ...extra,
});

const userPrompt = (query: string) => ({
  role: "user",
  content: [
    {
      type: "text",
      text: `<user_info>OS: darwin</user_info>\n<user_query>\n${query}\n</user_query>`,
    },
  ],
});

const buildCliFixtures = () => {
  buildCliChat({
    hash: "aaa",
    id: "chat-main",
    name: "Fix the router",
    meta: cliMeta(),
    messages: [
      { role: "system", content: "You are a coding agent." },
      { role: "user", content: [{ type: "text", text: "<user_info>injected only</user_info>" }] },
      userPrompt("Why is the router slow?"),
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "thinking" },
          { type: "text", text: "Let me look." },
          { type: "tool-call", toolName: "Read", args: {} },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", result: "big output" }] },
      { role: "assistant", content: [{ type: "tool-call", toolName: "Grep", args: {} }] },
      { role: "assistant", content: "It re-renders on every route change." },
      userPrompt("Fix it please."),
    ],
  });
  // A sub-agent chat, one with no folder, an old one, one with no user prompt,
  // and a folder with no store are all skipped.
  buildCliChat({
    hash: "aaa",
    id: "chat-sub",
    meta: cliMeta({ isSubagent: true }),
    messages: [userPrompt("sub")],
  });
  buildCliChat({
    hash: "aaa",
    id: "chat-nocwd",
    meta: cliMeta({ cwd: undefined }),
    messages: [userPrompt("x")],
  });
  buildCliChat({
    hash: "aaa",
    id: "chat-old",
    meta: cliMeta({ updatedAtMs: NOW - 90 * DAY, createdAtMs: NOW - 90 * DAY }),
    messages: [userPrompt("ancient")],
  });
  buildCliChat({
    hash: "bbb",
    id: "chat-injected-only",
    meta: cliMeta({ cwd: OTHER_WORKSPACE }),
    messages: [{ role: "user", content: "<user_info>injected</user_info>" }],
  });
  buildCliChat({
    hash: "bbb",
    id: "chat-nostore",
    meta: cliMeta({ cwd: OTHER_WORKSPACE }),
    skipStore: true,
  });
};

const buildEditorFixtures = (workspaceFolder: string) => {
  // Two storage ids for one folder, as Cursor creates after a workspace is reopened.
  for (const id of ["ws-one", "ws-two"]) {
    NodeFS.mkdirSync(NodePath.join(EDITOR_DIR, "workspaceStorage", id), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(EDITOR_DIR, "workspaceStorage", id, "workspace.json"),
      JSON.stringify({ folder: NodeURL.pathToFileURL(workspaceFolder).href }),
    );
  }
  NodeFS.mkdirSync(NodePath.dirname(EDITOR_DB), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(EDITOR_DB);
  db.exec(`
    CREATE TABLE composerHeaders (composerId TEXT, workspaceId TEXT, createdAt INTEGER, lastUpdatedAt INTEGER, isArchived INTEGER, isSubagent INTEGER);
    CREATE TABLE cursorDiskKV (key TEXT UNIQUE ON CONFLICT REPLACE, value BLOB);
  `);
  const header = db.prepare("INSERT INTO composerHeaders VALUES (?, ?, ?, ?, ?, ?)");
  const kv = db.prepare("INSERT INTO cursorDiskKV VALUES (?, ?)");
  const composer = (
    id: string,
    workspaceId: string,
    flags: { archived?: number; subagent?: number; updatedAt?: number },
    bubbles: ReadonlyArray<{ id: string; type: number; text?: string; createdAt?: string }>,
  ) => {
    header.run(
      id,
      workspaceId,
      NOW - 3 * DAY,
      flags.updatedAt ?? NOW - 3 * DAY + 60_000,
      flags.archived ?? 0,
      flags.subagent ?? 0,
    );
    kv.run(
      `composerData:${id}`,
      JSON.stringify({
        name: "Editor chat",
        fullConversationHeadersOnly: bubbles.map((bubble) => ({
          bubbleId: bubble.id,
          type: bubble.type,
        })),
      }),
    );
    for (const bubble of bubbles) {
      kv.run(
        `bubbleId:${id}:${bubble.id}`,
        JSON.stringify({ type: bubble.type, text: bubble.text ?? "", createdAt: bubble.createdAt }),
      );
    }
  };
  // Out of key order on purpose: the header list decides.
  composer("comp-main", "ws-two", {}, [
    { id: "b3", type: 2, text: "Done: renamed it.", createdAt: iso(NOW - 3 * DAY + 30_000) },
    { id: "b1", type: 1, text: "Rename the helper", createdAt: iso(NOW - 3 * DAY) },
    { id: "b2", type: 2, text: "", createdAt: iso(NOW - 3 * DAY + 10_000) },
  ]);
  composer("comp-archived", "ws-one", { archived: 1 }, [{ id: "a1", type: 1, text: "archived" }]);
  composer("comp-sub", "ws-one", { subagent: 1 }, [{ id: "s1", type: 1, text: "sub" }]);
  composer("comp-empty", "ws-one", {}, [{ id: "e1", type: 2, text: "assistant only" }]);
  composer("comp-old", "ws-one", { updatedAt: NOW - 90 * DAY }, [
    { id: "o1", type: 1, text: "old" },
  ]);
  composer("comp-other", "ws-unmapped", {}, [{ id: "x1", type: 1, text: "elsewhere" }]);
  db.close();
};

buildCliFixtures();
buildEditorFixtures(WORKSPACE);

it("reads CLI chats: message order, user_query stripping, skipped chats", () => {
  const read = CursorHistory.readCursorThreads(
    { chatsDir: CHATS_DIR, editorUserDir: null },
    [WORKSPACE, OTHER_WORKSPACE],
    SINCE,
  );
  expect(read._tag).toBe("Read");
  const threads = read._tag === "Read" ? read.value : [];
  expect(threads.map((thread) => thread.id)).toEqual(["chat-main"]);
  const [chat] = threads;
  expect(chat).toMatchObject({ title: "Fix the router", workspaceRoot: WORKSPACE });
  expect(chat?.messages.map((message) => [message.role, message.text])).toEqual([
    ["user", "Why is the router slow?"],
    ["assistant", "Let me look."],
    ["assistant", "It re-renders on every route change."],
    ["user", "Fix it please."],
  ]);
  // Times rise in message order and stay inside the chat's span.
  const times = chat?.messages.map((message) => message.createdAt) ?? [];
  expect(times).toEqual(times.toSorted());
  expect(JSON.stringify(read)).not.toContain("SECRET-KEY-MATERIAL");
});

it("reads editor chats in header order, merging workspace ids, skipping archived, sub-agent and empty chats", () => {
  const before = sha256(EDITOR_DB);
  const read = CursorHistory.readCursorThreads(
    { chatsDir: NodePath.join(FIXTURE_DIR, "no-chats"), editorUserDir: EDITOR_DIR },
    [WORKSPACE],
    SINCE,
  );
  expect(read._tag).toBe("Read");
  const threads = read._tag === "Read" ? read.value : [];
  expect(threads.map((thread) => thread.id)).toEqual(["editor:comp-main"]);
  expect(threads[0]?.title).toBe("Editor chat");
  // The assistant bubble is listed first, so it stays first; the empty one is dropped.
  expect(threads[0]?.messages.map((message) => [message.role, message.text])).toEqual([
    ["assistant", "Done: renamed it."],
    ["user", "Rename the helper"],
  ]);
  expect(sha256(EDITOR_DB)).toBe(before);
});

it("lists projects from both stores with chat counts inside the window", () => {
  const read = CursorHistory.readCursorProjects(paths, SINCE);
  const projects = read._tag === "Read" ? read.value : [];
  expect(
    projects.map((project) => [project.workspaceRoot, project.threadCount]).toSorted(),
  ).toEqual(
    [
      [WORKSPACE, 2],
      [OTHER_WORKSPACE, 1],
    ].toSorted(),
  );
  expect(
    CursorHistory.readCursorProjects(
      { chatsDir: "/nonexistent/chats", editorUserDir: null },
      SINCE,
    ),
  ).toEqual({ _tag: "NotFound" });
});

it("reports shapes it does not understand as unsupported, with a warning, and keeps the other store", () => {
  const badDir = NodePath.join(FIXTURE_DIR, "bad");
  const badChats = NodePath.join(badDir, "chats");
  buildCliChat({
    chatsDir: badChats,
    hash: "ccc",
    id: "weird",
    meta: cliMeta(),
    storeSchema: "CREATE TABLE something_else (a TEXT)",
  });
  const cliOnly = CursorHistory.readCursorThreads(
    { chatsDir: badChats, editorUserDir: null },
    [WORKSPACE],
    SINCE,
  );
  expect(cliOnly._tag).toBe("Unsupported");
  expect(CursorHistory.cursorReadWarning(cliOnly)).toBe(CursorHistory.CURSOR_UNSUPPORTED_WARNING);

  const badEditor = NodePath.join(badDir, "editor", "User");
  NodeFS.mkdirSync(NodePath.join(badEditor, "globalStorage"), { recursive: true });
  const db = new NodeSqlite.DatabaseSync(NodePath.join(badEditor, "globalStorage", "state.vscdb"));
  db.exec(
    "CREATE TABLE composerHeaders (composerId TEXT); CREATE TABLE cursorDiskKV (key TEXT, value BLOB)",
  );
  db.close();
  const mixed = CursorHistory.readCursorThreads(
    { chatsDir: CHATS_DIR, editorUserDir: badEditor },
    [WORKSPACE],
    SINCE,
  );
  expect(mixed._tag).toBe("Read");
  expect(mixed._tag === "Read" ? mixed.value.map((thread) => thread.id) : []).toEqual([
    "chat-main",
  ]);
  expect(CursorHistory.cursorReadWarning(mixed)).toBe(CursorHistory.CURSOR_UNSUPPORTED_WARNING);
});

it("finds the editor store where Cursor keeps it on each platform", () => {
  expect(CursorHistory.cursorEditorUserDir("darwin", "/Users/me", {})).toBe(
    "/Users/me/Library/Application Support/Cursor/User",
  );
  expect(
    CursorHistory.cursorEditorUserDir("win32", "C:\\Users\\me", {
      APPDATA: "C:\\Users\\me\\AppData\\Roaming",
    }),
  ).toBe("C:\\Users\\me\\AppData\\Roaming\\Cursor\\User");
  expect(CursorHistory.cursorEditorUserDir("linux", "/home/me", {})).toBe(
    "/home/me/.config/Cursor/User",
  );
  expect(CursorHistory.cursorEditorUserDir("linux", "/home/me", { XDG_CONFIG_HOME: "/xdg" })).toBe(
    "/xdg/Cursor/User",
  );
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
    Layer.provide(CursorHistory.layerFromPaths(paths)),
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
    ServerConfig.layerTest(process.cwd(), { prefix: "viewcode-cursor-import-config-" }),
  ),
  Layer.provideMerge(NodeServices.layer),
);

it.layer(integrationLayer)("Cursor import", (it) => {
  it.effect("scans, lists and imports Cursor chats as import:cursor threads", () =>
    Effect.gen(function* () {
      // The recency window is measured from when the fixtures were written, not the test clock's 0.
      yield* TestClock.setTime(NOW);
      const scanner = yield* AgentSessionScanner.AgentSessionScanner;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;

      const scan = yield* scanner.scan;
      expect(scan.candidates).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ path: WORKSPACE, sources: ["cursor"], threadCount: 2 }),
        ]),
      );

      const projectId = ProjectId.make("project-from-cursor");
      yield* engine.dispatch({
        type: "project.create",
        commandId: CommandId.make("create-project-from-cursor"),
        projectId,
        title: "workspace",
        workspaceRoot: WORKSPACE,
        defaultModelSelection: null,
        createdAt: "2026-03-01T00:00:00.000Z",
      });

      const listed = yield* listImportableAgentSessions({ projectId });
      expect(listed.warning).toBeUndefined();
      expect(
        listed.sessions
          .map((session) => [
            session.provider,
            session.providerInstanceId,
            session.providerSessionId,
            session.title,
          ])
          .toSorted(),
      ).toEqual(
        [
          ["cursor", "cursor", "chat-main", "Fix the router"],
          ["cursor", "cursor", "editor:comp-main", "Editor chat"],
        ].toSorted(),
      );

      const selection = listed.sessions.map(({ providerInstanceId, providerSessionId }) => ({
        providerInstanceId,
        providerSessionId,
      }));
      expect(yield* importRecentAgentThreads({ projectId, sessions: selection })).toEqual({
        importedCount: 2,
        skippedCount: 0,
      });

      const threadId = ThreadId.make("import:cursor:chat-main");
      const thread = Option.getOrThrow(yield* snapshots.getThreadDetailById(threadId));
      expect(thread.messages.map((message) => [message.role, message.text])).toEqual([
        ["user", "Why is the router slow?"],
        ["assistant", "Let me look."],
        ["assistant", "It re-renders on every route change."],
        ["user", "Fix it please."],
      ]);
      expect(thread.modelSelection.instanceId).toBe("cursor");
      expect(Option.getOrThrow(yield* directory.getBinding(threadId))).toMatchObject({
        provider: "cursor",
        providerInstanceId: "cursor",
        resumeCursor: null,
      });
      expect(
        Option.isSome(
          yield* snapshots.getThreadDetailById(ThreadId.make("import:cursor:editor:comp-main")),
        ),
      ).toBe(true);

      const relisted = yield* listImportableAgentSessions({ projectId });
      expect(relisted.sessions.every((session) => session.alreadyImported)).toBe(true);
    }),
  );
});

const cursorThread = (
  title: string | null,
  userTexts: ReadonlyArray<string>,
): CursorHistory.CursorThread => ({
  id: "chat-1",
  workspaceRoot: "/work/project",
  title,
  createdAt: "2026-10-01T10:00:00.000Z",
  updatedAt: "2026-10-01T11:00:00.000Z",
  sourcePath: "/fixture/store.db",
  messages: userTexts.flatMap((text, index) => [
    { role: "user" as const, text, createdAt: `2026-10-01T10:0${index}:00.000Z` },
    { role: "assistant" as const, text: "Done.", createdAt: `2026-10-01T10:0${index}:30.000Z` },
  ]),
});

const toSession = (thread: CursorHistory.CursorThread) => {
  const session = AgentSessionScanner.cursorThreadToAgentSession(thread);
  if (session === null) throw new Error("expected an importable Cursor chat");
  return session;
};

it("titles an untitled Cursor chat from its first message, not Cursor's 'New Agent'", () => {
  const thread = toSession(
    cursorThread("New Agent", ["Fix the summary page loading", "Now add a test"]),
  );
  expect(thread.title).toBe("Fix the summary page loading");
  expect(toSession(cursorThread("Root Cause Analysis", ["a", "b"])).title).toBe(
    "Root Cause Analysis",
  );
});

it("folds Cursor chats with a single prompt behind Show hidden", () => {
  const single = toSession(
    cursorThread(null, ["Please investigate why the dashboard is slow ".repeat(10)]),
  );
  expect(single.hiddenReason).toBe("too-short");
  const conversation = toSession(
    cursorThread(null, ["Investigate the slow dashboard", "Now fix it"]),
  );
  expect(conversation.hiddenReason).toBeNull();
});
