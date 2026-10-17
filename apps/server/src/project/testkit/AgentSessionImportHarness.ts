import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Context from "effect/Context";
import * as Option from "effect/Option";
import * as DateTime from "effect/DateTime";
import * as SqlClient from "effect/sql/SqlClient";
import { ProviderDriverKind, ProviderInstanceId, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as ServerConfig from "../../config.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as Sqlite from "../../persistence/Sqlite.ts";
import * as ProviderSessionRuntime from "../../persistence/ProviderSessionRuntime.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../../orchestration-v2/ProjectStore.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as EventStore from "../../orchestration-v2/EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as AgentSessionScanner from "../AgentSessionScanner.ts";
import * as AgentSessionImporter from "../AgentSessionImporter.ts";
import * as ProjectService from "../ProjectService.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  return {
    createProject: (input: {projectId:ProjectId;workspaceRoot:string}) => sql`INSERT INTO projection_projects
      (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${input.projectId},'workspace',${input.workspaceRoot},'[]','2026-03-01T00:00:00.000Z','2026-03-01T00:00:00.000Z')`,
    thread: (threadId:ThreadId) => projections.getThreadRecords(threadId,["messages"]).pipe(Effect.map((projection) => ({
      ...projection.thread, messages:projection.messages.map((message) => ({...message, createdAt:DateTime.formatIso(message.createdAt)})),
    }))),
    sequence: sql<{count:number}>`SELECT COUNT(*) AS count FROM orchestration_events`.pipe(Effect.map((rows) => rows[0]!.count)),
  };
});
export class AgentSessionImportHarness extends Context.Service<AgentSessionImportHarness,Effect.Success<typeof make>>() ("t3/project/testkit/AgentSessionImportHarness") {}

/** Native events/projections and persistent import receipts; provider processes never start. */
export function layer<R>(source: Layer.Layer<R>) {
  const stores = Layer.mergeAll(ProjectStore.layer, ProjectionStore.layer, EventStore.layer, ProviderSessionRuntime.layer);
  const base = EventSink.layer.pipe(Layer.provideMerge(stores),Layer.provideMerge(Sqlite.layerMemory));
  const projects = Layer.unwrap(Effect.map(ProjectStore.ProjectStoreV2, (store) => Layer.mock(ProjectService.ProjectService)({getById: (id) => store.get(id).pipe(Effect.map(Option.map((row) => ({...row,id:row.projectId,repositoryIdentity:null}))),Effect.orDie)})));
  const orchestrator = Layer.unwrap(Effect.map(ProjectionStore.ProjectionStoreV2, (store) => Layer.mock(Orchestrator.OrchestratorV2)({getThreadRecords: (id,fields) => store.getThreadRecords(id,fields).pipe(Effect.mapError(() => new Orchestrator.OrchestratorProjectionError({threadId:id})))})));
  return Layer.mergeAll(
    Layer.effect(AgentSessionImportHarness,make),
    AgentSessionImporter.layer.pipe(Layer.provide(Layer.mergeAll(projects,orchestrator,IdAllocator.layer))),
  ).pipe(
    Layer.provideMerge(AgentSessionScanner.layer.pipe(Layer.provide(source))),
    Layer.provideMerge(base),
    Layer.provide(ServerSettings.layerTest({providerInstances:{
      [ProviderInstanceId.make("claudeAgent")]:{driver:ProviderDriverKind.make("claudeAgent"),enabled:false},
      [ProviderInstanceId.make("codex")]:{driver:ProviderDriverKind.make("codex"),enabled:false},
    }})),
    Layer.provide(ServerConfig.layerTest(process.cwd(),{prefix:"viewcode-import-native-"})),
    Layer.provideMerge(NodeServices.layer),
  );
}
