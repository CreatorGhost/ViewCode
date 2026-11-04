import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Receipts from "./CommandReceiptStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";

it.effect(
  "persists an explicit empty panel thread with a disabled provider, without messages/runs/provider opens; actual send stays blocked",
  () => {
    const instanceId = ProviderInstanceId.make("codex");
    const threadId = ThreadId.make("empty-panel-thread");
    const projectId = ProjectId.make("empty-panel-project");
    const openSession = vi.fn(() =>
      Effect.die("record-only panel creation must not open a provider"),
    );
    const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession,
    };
    const database = Sqlite.layerMemory;
    const runtime = ProviderReplayHarness.layerWithRegistry(
      { name: "empty-panel-record-only" },
      ProviderAdapterRegistry.layerFromAdapters([adapter]),
      { databaseLayer: database },
    );
    const receipts = Receipts.layer.pipe(Layer.provide(database));
    const management = ThreadManagement.layer.pipe(
      Layer.provide(runtime),
      Layer.provide(receipts),
      Layer.provide(
        ServerSettings.layerTest({
          ...DEFAULT_SERVER_SETTINGS,
          providerInstances: {
            [instanceId]: { driver: ProviderDriverKind.make("codex"), enabled: false },
          },
        }),
      ),
    );
    return Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const created = yield* threads.dispatch({
        type: "thread.create",
        commandId: CommandId.make("empty-panel-create"),
        threadId,
        projectId,
        title: "New thread",
        modelSelection: { instanceId, model: DEFAULT_MODEL },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: "feature-base",
        worktreePath: null,
        viewcodeGoal: {
          objective: "Keep unsent work",
          pausedAt: null,
          updatedAt: "2026-10-18T10:00:00.000Z",
        },
        debugMode: true,
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      const projection = yield* threads.getThreadProjection(threadId);
      expect(created.storedEvents.map((stored) => stored.event.type)).toEqual(["thread.created"]);
      expect(projection.thread).toMatchObject({
        activeProviderThreadId: null,
        branch: "feature-base",
        worktreePath: null,
        debugMode: true,
        viewcodeGoal: { objective: "Keep unsent work" },
      });
      expect(projection.messages).toEqual([]);
      expect(projection.runs).toEqual([]);
      expect(projection.providerThreads).toEqual([]);
      expect(projection.runtimeRequests).toEqual([]);
      expect(openSession).not.toHaveBeenCalled();
      const refused = yield* Effect.flip(
        threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("empty-panel-disabled-send"),
          threadId,
          messageId: MessageId.make("empty-panel-message"),
          text: "This must remain blocked",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
          createdBy: "user",
          creationSource: "web",
        }),
      );
      expect(refused).toBeInstanceOf(
        ThreadManagement.ThreadManagementProviderInstanceDisabledError,
      );
      yield* worker.drain();
      expect((yield* threads.getThreadProjection(threadId)).runs).toEqual([]);
      expect(openSession).not.toHaveBeenCalled();
    }).pipe(Effect.provide(Layer.merge(runtime, management)));
  },
);
