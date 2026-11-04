import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";
import { runMigrations } from "./Migrations.ts";
import { repairViewCodeMigrationLedger, runViewCodeMigrations } from "./ViewCodeMigrations.ts";

// Reproduce the ledger shipped before the split, after its schema has run.
const legacyLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 54 });
  yield* runViewCodeMigrations();
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    SELECT migration_id + 54, name, '2026-10-01 00:00:00' FROM viewcode_sql_migrations
  `;
  yield* sql`DELETE FROM viewcode_sql_migrations`;
});

const readLedger = (table: "effect_sql_migrations" | "viewcode_sql_migrations") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`
      SELECT migration_id, name, created_at FROM ${sql(table)} ORDER BY migration_id
    `;
  });

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

describe("ViewCode migration ledger", () => {
  it.effect("repairs the released ledger once without changing fork values or timestamps", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacyLedger;
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, created_at, updated_at, parent_thread_id, kind, goal_json, debug_mode)
        VALUES ('child', 'project', 'Child', '{"providerInstanceId":"codex","model":"gpt-5"}', '2026-10-01', '2026-10-01', 'lead', 'sidechat', '{"objective":"Keep this"}', 1)`;
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, project_color)
        VALUES ('project', 'Project', '/tmp/project', '[]', '2026-10-01', '2026-10-01', '#abcdef')`;
      yield* sql`INSERT INTO projection_thread_pull_requests
        (thread_id, host, repository, number, url, source, linked_at, watch_json)
        VALUES ('child', 'github.com', 'owner/repo', 1, 'https://github.com/owner/repo/pull/1', 'manual', '2026-10-01', '{"enabled":true}')`;
      const threads = yield* sql`SELECT * FROM projection_threads`;
      const projects = yield* sql`SELECT * FROM projection_projects`;
      const prs = yield* sql`SELECT * FROM projection_thread_pull_requests`;
      yield* runMigrations();
      const upstream = yield* readLedger("effect_sql_migrations");
      const fork = yield* readLedger("viewcode_sql_migrations");
      assert.equal(upstream.at(-1)?.migration_id, 63);
      assert.equal(fork.length, 6);
      assert.isTrue(fork.every((row) => row.created_at === "2026-10-01 00:00:00"));
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_threads`, threads);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_projects`, projects);
      assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_pull_requests`, prs);
      yield* runMigrations();
      assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), upstream);
      assert.deepStrictEqual(yield* readLedger("viewcode_sql_migrations"), fork);
    }).pipe(Effect.provide(layer)),
  );

  it.effect.each([55, 56, 57, 58, 59, 60])(
    "finishes an install that stopped at old migration %s",
    (last) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* legacyLedger;
        yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id > ${last}`;
        yield* runMigrations();
        assert.equal((yield* readLedger("effect_sql_migrations")).at(-1)?.migration_id, 63);
        assert.equal((yield* readLedger("viewcode_sql_migrations")).length, 6);
      }).pipe(Effect.provide(layer)),
  );

  it.effect("finishes a released install whose schema stopped after adding parentThreadId", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`ALTER TABLE projection_threads ADD COLUMN parent_thread_id TEXT`;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'ProjectionThreadsParentThreadId')`;
      yield* runMigrations();
      const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
      assert.includeMembers(
        columns.map((column) => column.name),
        ["parent_thread_id", "kind", "goal_json", "debug_mode"],
      );
      assert.equal((yield* readLedger("effect_sql_migrations")).at(-1)?.migration_id, 63);
      assert.equal((yield* readLedger("viewcode_sql_migrations")).length, 6);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("leaves upstream and unknown migration names alone", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (55, 'OrchestrationV2'), (56, 'SiteLocalMigration'), (90, 'FutureMigration')`;
      const before = yield* readLedger("effect_sql_migrations");
      yield* repairViewCodeMigrationLedger();
      assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), before);
      assert.deepStrictEqual(yield* readLedger("viewcode_sql_migrations"), []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rolls back all ledger moves if the fork ledger conflicts", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* legacyLedger;
      yield* sql`INSERT INTO viewcode_sql_migrations (migration_id, name) VALUES (3, 'UnknownMigration')`;
      const before = yield* readLedger("effect_sql_migrations");
      const forkBefore = yield* readLedger("viewcode_sql_migrations");
      assert.isTrue(Exit.isFailure(yield* Effect.exit(repairViewCodeMigrationLedger())));
      assert.deepStrictEqual(yield* readLedger("effect_sql_migrations"), before);
      assert.deepStrictEqual(yield* readLedger("viewcode_sql_migrations"), forkBefore);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("refuses holes that the private migrator would otherwise skip", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`DELETE FROM viewcode_sql_migrations WHERE migration_id = 2`;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(runViewCodeMigrations())));
    }).pipe(Effect.provide(layer)),
  );
});
