// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Importer from "./AgentSessionImporter.ts";
import * as T3History from "./T3CodeHistory.ts";
import * as ImportHarness from "./testkit/AgentSessionImportHarness.ts";

const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "viewcode-import-lineage-"));
const workspace = NodePath.join(directory, "workspace");
NodeFS.mkdirSync(workspace);
afterAll(() => NodeFS.rmSync(directory, { recursive: true, force: true }));
const at = "2026-10-18T00:00:00.000Z";
const source = (id: string, parentThreadId: string | null): T3History.T3CodeThread => ({
  id,
  projectId: "source",
  title: id,
  instanceId: "codex",
  model: "gpt-6",
  createdAt: at,
  updatedAt: at,
  parentThreadId,
  binding: null,
  messages: [
    { role: "user", text: `Please keep ${id}'s complete original question.`, createdAt: at },
    { role: "assistant", text: `The answer to ${id}.`, createdAt: at },
  ],
});
const layer = ImportHarness.layer(
  Layer.succeed(T3History.T3CodeHistory, {
    projects: Effect.succeed({
      _tag: "Read" as const,
      databasePath: "/fixture/state.sqlite",
      value: [
        {
          id: "source",
          title: "Source",
          workspaceRoot: workspace,
          threadCount: 6,
          lastActiveAt: at,
        },
      ],
    }),
    threads: () =>
      Effect.succeed({
        _tag: "Read" as const,
        databasePath: "/fixture/state.sqlite",
        value: [
          source("grandchild", "child"),
          source("child", "parent"),
          source("parent", null),
          source("orphan", "missing"),
          source("cycle-a", "cycle-b"),
          source("cycle-b", "cycle-a"),
        ],
      }),
  }),
);
const selection = (...ids: string[]) =>
  ids.map((providerSessionId) => ({
    providerSessionId,
    providerInstanceId: ProviderInstanceId.make("codex"),
  }));
const imported = (id: string) => ThreadId.make(`import:t3code:${id}`);

it.effect(
  "nests child-first imports under native lineage, keeps text, and leaves missing/cyclic parents flat",
  () =>
    Effect.gen(function* () {
      const harness = yield* ImportHarness.AgentSessionImportHarness;
      const importer = yield* Importer.AgentSessionImporter;
      const projectId = ProjectId.make("lineage-project");
      yield* harness.createProject({ projectId, workspaceRoot: workspace });
      expect(yield* importer.importRecentAgentThreads({ projectId })).toEqual({
        importedCount: 6,
        skippedCount: 0,
      });
      const child = yield* harness.thread(imported("child"));
      const grandchild = yield* harness.thread(imported("grandchild"));
      expect(child.parentThreadId).toBe(imported("parent"));
      expect(child.lineage).toEqual({
        parentThreadId: imported("parent"),
        rootThreadId: imported("parent"),
        relationshipToParent: "subagent",
      });
      expect(grandchild.lineage).toEqual({
        parentThreadId: imported("child"),
        rootThreadId: imported("parent"),
        relationshipToParent: "subagent",
      });
      expect(grandchild.messages.map((m) => m.text)).toEqual(
        source("grandchild", "child").messages.map((m) => m.text),
      );
      for (const id of ["orphan", "cycle-a", "cycle-b"])
        expect((yield* harness.thread(imported(id))).lineage.parentThreadId).toBeNull();
      const before = yield* harness.sequence;
      yield* importer.importRecentAgentThreads({ projectId });
      expect(yield* harness.sequence).toBe(before);
    }).pipe(Effect.provide(layer)),
);

it.effect("attaches a selected child to its already imported parent", () =>
  Effect.gen(function* () {
    const harness = yield* ImportHarness.AgentSessionImportHarness;
    const importer = yield* Importer.AgentSessionImporter;
    const projectId = ProjectId.make("existing-parent-project");
    yield* harness.createProject({ projectId, workspaceRoot: workspace });
    yield* importer.importRecentAgentThreads({ projectId, sessions: selection("parent") });
    yield* importer.importRecentAgentThreads({ projectId, sessions: selection("child") });
    expect((yield* harness.thread(imported("child"))).lineage.parentThreadId).toBe(
      imported("parent"),
    );
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a parent link into another project's imported tree", () =>
  Effect.gen(function* () {
    const harness = yield* ImportHarness.AgentSessionImportHarness;
    const importer = yield* Importer.AgentSessionImporter;
    const projectId = ProjectId.make("child-project");
    const other = ProjectId.make("other-parent-project");
    yield* harness.createProject({ projectId: other, workspaceRoot: workspace });
    yield* importer.importRecentAgentThreads({ projectId: other, sessions: selection("parent") });
    yield* harness.createProject({ projectId, workspaceRoot: workspace });
    yield* importer.importRecentAgentThreads({ projectId, sessions: selection("child") });
    expect((yield* harness.thread(imported("child"))).lineage.parentThreadId).toBeNull();
    expect((yield* harness.thread(imported("parent"))).projectId).toBe(other);
  }).pipe(Effect.provide(layer)),
);
