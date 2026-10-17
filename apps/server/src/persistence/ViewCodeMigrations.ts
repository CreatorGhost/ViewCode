import * as Effect from "effect/Effect";
import * as Migrator from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import parentThreadId from "./ViewCodeMigrations/001_ProjectionThreadsParentThreadId.ts";
import pullRequestWatch from "./ViewCodeMigrations/002_ProjectionThreadPullRequestWatch.ts";
import threadKind from "./ViewCodeMigrations/003_ProjectionThreadsKind.ts";
import projectColor from "./ViewCodeMigrations/004_ProjectionProjectColor.ts";
import goalDebugMode from "./ViewCodeMigrations/005_ProjectionThreadsGoalDebugMode.ts";
import parentThreadIdIndex from "./ViewCodeMigrations/006_ProjectionThreadsParentThreadIdIndex.ts";

const entries = [
  [1, "ProjectionThreadsParentThreadId", parentThreadId],
  [2, "ProjectionThreadPullRequestWatch", pullRequestWatch],
  [3, "ProjectionThreadsKind", threadKind],
  [4, "ProjectionProjectColor", projectColor],
  [5, "ProjectionThreadsGoalDebugMode", goalDebugMode],
  [6, "ProjectionThreadsParentThreadIdIndex", parentThreadIdIndex],
] as const;

const ensureLedger = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS viewcode_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      created_at DATETIME NOT NULL DEFAULT current_timestamp,
      name VARCHAR(255) NOT NULL
    )
  `;
});

/** Move only the six released fork entries. Upstream and unknown names stay intact. */
export const repairViewCodeMigrationLedger = Effect.fn("repairViewCodeMigrationLedger")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
          SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (tables.length === 0) return;
        yield* ensureLedger;
        for (const [id, name] of entries) {
          const legacyId = id + 54;
          const legacy = yield* sql<{ readonly created_at: string }>`
            SELECT created_at FROM effect_sql_migrations
            WHERE migration_id = ${legacyId} AND name = ${name}
          `;
          if (legacy.length === 0) continue;
          const existing = yield* sql<{ readonly name: string }>`
            SELECT name FROM viewcode_sql_migrations WHERE migration_id = ${id}
          `;
          if (existing.some((row) => row.name !== name)) {
            return yield* new Migrator.MigrationError({
              kind: "BadState",
              message: `ViewCode migration ${id} has an unexpected name. The legacy ledger was not changed.`,
            });
          }
          yield* sql`
            INSERT OR IGNORE INTO viewcode_sql_migrations (migration_id, name, created_at)
            VALUES (${id}, ${name}, ${legacy[0]!.created_at})
          `;
          yield* sql`
            DELETE FROM effect_sql_migrations WHERE migration_id = ${legacyId} AND name = ${name}
          `;
        }
      }),
    );
  },
);

const run = Migrator.make({});

export const runViewCodeMigrations = Effect.fn("runViewCodeMigrations")(function* () {
  yield* ensureLedger;
  const sql = yield* SqlClient.SqlClient;
  const recorded = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM viewcode_sql_migrations
  `;
  const latest = Math.max(0, ...recorded.map((row) => row.migration_id));
  for (const [id, name] of entries) {
    if (id <= latest && !recorded.some((row) => row.migration_id === id && row.name === name)) {
      return yield* new Migrator.MigrationError({
        kind: "BadState",
        message: `ViewCode migration history would skip required migration ${id}_${name}.`,
      });
    }
  }
  return yield* run({
    table: "viewcode_sql_migrations",
    loader: Migrator.fromRecord(
      Object.fromEntries(entries.map(([id, name, migration]) => [`${id}_${name}`, migration])),
    ),
  });
});
