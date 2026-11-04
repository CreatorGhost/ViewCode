import { expect, it } from "@effect/vitest";
import {
  EventId,
  NodeId,
  RuntimeRequestId,
  type OrchestrationV2RuntimeRequest,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Projections from "../orchestration-v2/ProjectionStore.ts";
import { ComputerUsePendingApprovals, pendingApprovalsLayer } from "./ComputerUseService.ts";
import {
  v2Now,
  v2Projection,
} from "../../../../packages/client-runtime/src/state/orchestrationV2TestFixtures.ts";

const layer = pendingApprovalsLayer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(Sqlite.layerMemory, Projections.layer.pipe(Layer.provide(Sqlite.layerMemory))),
  ),
);
it.effect(
  "pauses computer input for native approvals, ignores questions/own cards/archived threads, and fails closed on storage errors",
  () =>
    Effect.gen(function* () {
      const guard = yield* ComputerUsePendingApprovals;
      const projections = yield* Projections.ProjectionStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const threadId = v2Projection.thread.id;
      yield* projections.apply({
        id: EventId.make("computer:thread"),
        type: "thread.created",
        threadId,
        occurredAt: v2Now,
        payload: v2Projection.thread,
      });
      expect(yield* guard.anyPending).toBe(false);
      const update = (
        id: string,
        kind: OrchestrationV2RuntimeRequest["kind"],
        status: OrchestrationV2RuntimeRequest["status"] = "pending",
      ) =>
        projections.apply({
          id: EventId.make(`computer:${id}:${status}`),
          type: "runtime-request.updated",
          threadId,
          occurredAt: v2Now,
          payload: {
            id: RuntimeRequestId.make(id),
            nodeId: NodeId.make("computer:node"),
            providerTurnId: null,
            nativeRequestRef: null,
            kind,
            status,
            responseCapability: { type: "not_resumable", reason: "test" },
            createdAt: v2Now,
            resolvedAt: null,
          },
        });
      yield* update("question", "user_input");
      yield* update("auth", "auth_refresh");
      yield* update("computer-use:own", "permission");
      expect(yield* guard.anyPending).toBe(false);
      yield* update("provider-approval", "command");
      expect(yield* guard.anyPending).toBe(true);
      yield* update("provider-approval", "command", "resolved");
      expect(yield* guard.anyPending).toBe(false);
      yield* update("provider-approval", "command");
      yield* projections.apply({
        id: EventId.make("computer:archive"),
        type: "thread.archived",
        threadId,
        occurredAt: v2Now,
        payload: { ...v2Projection.thread, archivedAt: v2Now },
      });
      expect(yield* guard.anyPending).toBe(false);
      yield* sql`DROP TABLE orchestration_v2_projection_runtime_requests`;
      expect(yield* guard.anyPending).toBe(true);
    }).pipe(Effect.provide(layer)),
);
