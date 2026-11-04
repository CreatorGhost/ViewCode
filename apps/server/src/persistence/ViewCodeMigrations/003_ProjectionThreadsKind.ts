import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Kept in ViewCode's separate migration ledger. Safe to reapply during ledger repair.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!columns.some((column) => column.name === "kind")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN kind TEXT
    `;
  }
});
