import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Kept in ViewCode's separate migration ledger. Safe to reapply during ledger repair.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!columns.some((column) => column.name === "project_color")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN project_color TEXT
    `;
  }
});
