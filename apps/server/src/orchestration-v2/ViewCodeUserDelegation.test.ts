import { assert, it } from "@effect/vitest";
import {
  AuthOrchestrationReadScope,
  AuthOrchestrationOperateScope,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
  ThreadId,
  type OrchestrationV2Command,
  type OrchestrationV2RunStatus,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { withCreationProvenance } from "./ThreadManagementService.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider needed for command validation"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const database = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  database,
  ProjectionStore.layer.pipe(Layer.provide(database)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "viewcode-user-delegation" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ),
);

const seed = Effect.fn("test.manualDelegation.seed")(function* (
  status: OrchestrationV2RunStatus = "completed",
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const sink = yield* EventSink.EventSinkV2;
  const parentThreadId = ThreadId.make("thread:manual-parent");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create-parent"),
    threadId: parentThreadId,
    projectId: ProjectId.make("project:manual"),
    title: "Parent",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "vc/parent",
    worktreePath: "/parent-checkout",
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make("start-parent"),
    threadId: parentThreadId,
    messageId: MessageId.make("message:parent"),
    text: "Original work",
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  const parent = yield* projections.getThreadProjection(parentThreadId);
  const run = parent.runs[0]!;
  const node = parent.nodes.find((entry) => entry.id === run.rootNodeId)!;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make("finish-parent-run"),
        type: "run.updated",
        threadId: parentThreadId,
        runId: run.id,
        occurredAt: now,
        payload: { ...run, status, completedAt: now },
      },
      {
        id: EventId.make("finish-parent-node"),
        type: "node.updated",
        threadId: parentThreadId,
        runId: run.id,
        nodeId: node.id,
        occurredAt: now,
        payload: { ...node, status: "completed", completedAt: now },
      },
    ],
  });
  const command: Extract<OrchestrationV2Command, { type: "delegated_task.request" }> = {
    type: "delegated_task.request",
    viewcodeUserRequested: true,
    commandId: CommandId.make("manual-child"),
    parentThreadId,
    parentRunId: run.id,
    parentNodeId: node.id,
    task: "Inspect the code",
    title: "Inspector",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    workspaceStrategy: { type: "worktree", baseRef: "vc/parent", startFromOrigin: false },
    completionWake: "settled_only",
    createdBy: "user",
    creationSource: "web",
  };
  return { orchestrator, projections, sink, command, parent, run, node };
});

it.effect(
  "creates a native delegated child from a completed parent in its own pending worktree",
  () =>
    Effect.gen(function* () {
      const { orchestrator, projections, command, parent } = yield* seed();
      yield* orchestrator.dispatch(command);
      const after = yield* projections.getThreadProjection(parent.thread.id);
      assert.equal(after.runs[0]!.status, "completed");
      assert.lengthOf(after.subagents, 1);
      const task = after.subagents[0]!;
      const child = yield* projections.getThreadProjection(task.childThreadId!);
      assert.equal(task.origin, "app_owned");
      assert.equal(task.createdBy, "user");
      assert.equal(child.thread.lineage.parentThreadId, parent.thread.id);
      assert.isNull(child.thread.worktreePath);
      assert.equal(child.runs[0]!.status, "preparing");
      assert.deepEqual(child.runs[0]!.workspacePreparation, command.workspaceStrategy);
      assert.equal(child.messages[0]!.text, command.task);
    }).pipe(Effect.provide(layerTest)),
);

it.effect.each([
  "agent",
  "mcp-spoof",
  "no-marker",
  "shared-workspace",
  "wrong-root",
  "missing-node",
] as const)("rejects unsafe completed-parent manual delegation: %s", (variant) =>
  Effect.gen(function* () {
    const { orchestrator, projections, command, sink, node, parent } = yield* seed();
    let attempt = command;
    if (variant === "agent") attempt = { ...command, createdBy: "agent" };
    if (variant === "mcp-spoof")
      attempt = withCreationProvenance(command, {
        createdBy: "agent",
        creationSource: "mcp",
      }) as typeof command;
    if (variant === "no-marker") attempt = { ...command, viewcodeUserRequested: false };
    if (variant === "shared-workspace")
      attempt = { ...command, workspaceStrategy: { type: "root" } };
    if (variant === "missing-node")
      attempt = { ...command, parentNodeId: NodeId.make("not-a-real-node") };
    if (variant === "wrong-root") {
      const other = { ...node, id: NodeId.make("real-sibling-not-root"), parentNodeId: node.id };
      yield* sink.write({
        events: [
          {
            id: EventId.make("sibling-node"),
            type: "node.updated",
            threadId: parent.thread.id,
            runId: command.parentRunId,
            nodeId: other.id,
            occurredAt: yield* DateTime.now,
            payload: other,
          },
        ],
      });
      attempt = { ...command, parentNodeId: other.id };
    }
    const result = yield* Effect.exit(orchestrator.dispatch(attempt));
    assert.equal(result._tag, "Failure");
    assert.lengthOf((yield* projections.getThreadProjection(parent.thread.id)).subagents, 0);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("does not treat failed runs as completed parents", () =>
  Effect.gen(function* () {
    const { orchestrator, command } = yield* seed("failed");
    assert.equal((yield* Effect.exit(orchestrator.dispatch(command)))._tag, "Failure");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects manual children after their parent thread is archived", () =>
  Effect.gen(function* () {
    const { orchestrator, command } = yield* seed();
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make("archive-parent"),
      threadId: command.parentThreadId,
    });
    assert.equal((yield* Effect.exit(orchestrator.dispatch(command)))._tag, "Failure");
  }).pipe(Effect.provide(layerTest)),
);

it.effect("the user-requested marker cannot bypass authenticated operate permission", () =>
  Effect.gen(function* () {
    const method = ORCHESTRATION_V2_WS_METHODS.dispatchCommand;
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof method> =>
          tag !== method,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(method, () =>
            Effect.sync(() => {
              handled = true;
              return { sequence: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    const error = yield* client[method]({
      type: "delegated_task.request",
      viewcodeUserRequested: true,
      commandId: CommandId.make("manual-readonly"),
      parentThreadId: ThreadId.make("parent"),
      parentRunId: RunId.make("run"),
      parentNodeId: NodeId.make("root"),
      task: "Inspect",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "worktree", baseRef: "HEAD" },
      createdBy: "user",
      creationSource: "web",
    }).pipe(Effect.flip);
    assert.propertyVal(error, "requiredPermission", AuthOrchestrationOperateScope);
    assert.isFalse(handled);
  }).pipe(Effect.scoped),
);
