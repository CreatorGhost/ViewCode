import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ViewCode pull request watches. Idempotent on purpose, like 055: when an upstream T3 Code
// migration claims this number, renumber this one after it and it re-runs harmlessly on
// databases that already have the column.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_thread_pull_requests)
  `;
  if (!columns.some((column) => column.name === "watch_json")) {
    yield* sql`
      ALTER TABLE projection_thread_pull_requests
      ADD COLUMN watch_json TEXT
    `;
  }
});
