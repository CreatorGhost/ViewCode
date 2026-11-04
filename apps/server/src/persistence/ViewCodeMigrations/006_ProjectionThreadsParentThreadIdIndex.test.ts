import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { runMigrations } from "../Migrations.ts";
import migration from "./006_ProjectionThreadsParentThreadIdIndex.ts";

it.layer(Layer.mergeAll(NodeSqliteClient.layer({ filename: ":memory:" })))(
  "006_ProjectionThreadsParentThreadIdIndex",
  (it) => {
    it.effect("indexes parent lookups on an existing database and can rerun safely", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations();
        yield* migration;
        const columns = yield* sql<{
          readonly name: string;
        }>`PRAGMA index_info('idx_projection_threads_parent_thread_id')`;
        assert.deepStrictEqual(
          columns.map((column) => column.name),
          ["parent_thread_id"],
        );
        const plan = yield* sql<{
          readonly detail: string;
        }>`EXPLAIN QUERY PLAN SELECT thread_id FROM projection_threads WHERE parent_thread_id = 'lead'`;
        assert.ok(
          plan.some((row) => row.detail.includes("idx_projection_threads_parent_thread_id")),
        );
      }),
    );
  },
);
