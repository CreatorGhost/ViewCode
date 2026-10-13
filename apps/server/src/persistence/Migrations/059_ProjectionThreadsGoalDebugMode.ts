import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ViewCode thread goal (JSON) and debug mode (0/1). Idempotent on purpose: when
// an upstream T3 Code migration claims this number, renumber this one after it.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "goal_json")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN goal_json TEXT
    `;
  }
  if (!columns.some((column) => column.name === "debug_mode")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN debug_mode INTEGER
    `;
  }
});
