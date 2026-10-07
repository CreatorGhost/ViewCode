import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// ViewCode side chats (`kind = 'sidechat'`). Idempotent on purpose: when an
// upstream T3 Code migration claims this number, renumber this one after it.
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
