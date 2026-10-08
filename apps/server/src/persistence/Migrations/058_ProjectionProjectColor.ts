import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ViewCode project colours. Idempotent on purpose, like 055: when an upstream T3 Code
// migration claims this number, renumber this one after it.
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
