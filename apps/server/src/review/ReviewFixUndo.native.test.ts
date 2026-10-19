import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunId,
  ThreadId,
  REVIEW_FIX_STARTED_ACTIVITY_KIND,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ServerSettings from "../serverSettings.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { SHARED_WORKSPACE_RESTORE_MESSAGE } from "../orchestration-v2/CheckpointRestoreSafety.ts";
import * as ReviewActivities from "./ReviewActivityStoreV2.ts";
import * as ReviewFix from "./ReviewFixThread.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-review-undo" };
const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
    assert.equal(Number(code), 0, `git ${args.join(" ")}`);
  });

it.effect.each(["root", "shared", "archived-shared", "exclusive"] as const)(
  "uses native checkpoint admission and the real rollback worker/filesystem for %s review fixes",
  (mode) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const temp = yield* fs.makeTempDirectoryScoped({ prefix: "viewcode-review-undo-" });
      const repository = path.join(temp, "repository");
      const exclusive = path.join(temp, "exclusive");
      yield* fs.makeDirectory(repository);
      const original = "export const calculate = (n) => n * 10;\n";
      const fixed = "export const calculate = (n) => n / 10;\n";
      yield* fs.writeFileString(path.join(repository, "calc.js"), original);
      yield* git(repository, ["init"]);
      yield* git(repository, ["config", "user.name", "ViewCode Test"]);
      yield* git(repository, ["config", "user.email", "viewcode-test@example.com"]);
      yield* git(repository, ["add", "."]);
      yield* git(repository, ["commit", "-m", "review baseline"]);
      if (mode !== "root")
        yield* git(repository, ["worktree", "add", "-b", "vc/review-undo", exclusive]);
      const cwd = mode === "root" ? repository : exclusive;
      const baselineRef = CheckpointRef.make("refs/viewcode/test/review-undo/0");
      const postRef = CheckpointRef.make("refs/viewcode/test/review-undo/1");
      yield* git(cwd, ["update-ref", baselineRef, "HEAD"]);
      yield* fs.writeFileString(path.join(cwd, "calc.js"), fixed);
      yield* git(cwd, ["add", "."]);
      yield* git(cwd, ["commit", "-m", "controlled review fix"]);
      yield* git(cwd, ["update-ref", postRef, "HEAD"]);
      let providerRollbacks = 0;
      const adapter: ProviderAdapter.ProviderAdapterV2["Service"] = {
        driver,
        instanceId,
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
        openSession: (input) =>
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const unused = () => Effect.die("Review undo must not start a provider turn");
            return {
              driver,
              instanceId,
              providerSessionId: input.providerSessionId,
              providerSession: {
                id: input.providerSessionId,
                driver,
                providerInstanceId: instanceId,
                status: "ready",
                cwd,
                model: modelSelection.model,
                capabilities: CodexProviderCapabilitiesV2,
                createdAt: now,
                updatedAt: now,
                lastError: null,
              },
              events: Stream.never,
              ensureThread: unused,
              resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
              startTurn: unused,
              compactThread: unused,
              steerTurn: unused,
              interruptTurn: unused,
              respondToRuntimeRequest: unused,
              readThreadSnapshot: unused,
              forkThread: unused,
              rollbackThread: ({ providerThread }) =>
                Effect.sync(() => {
                  providerRollbacks++;
                  return { providerThread, providerTurns: [], messages: [], runtimeRequests: [] };
                }),
            } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
          }),
      };
      const layer = ProviderHarness.layerWithRegistry(
        { name: `viewcode-review-undo-${mode}`, runtimePolicyOverride: { cwd } },
        ProviderRegistry.layerFromAdapters([adapter]),
        { runEffectWorker: false },
      );
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("review-fix");
        const providerThreadId = ProviderThreadId.make("review-fix-provider");
        const providerSessionId = ProviderSessionId.make("review-fix-session");
        const runId = RunId.make("review-fix-run");
        const nodeId = NodeId.make("review-fix-node");
        const scopeId = CheckpointScopeId.make("review-fix-scope");
        const checkpointId = CheckpointId.make("review-fix-before");
        const now = yield* DateTime.now;
        yield* orchestrator.dispatch({
          type: "thread.create",
          commandId: CommandId.make("review-fix-create"),
          threadId,
          projectId: ProjectId.make("review-project"),
          title: "Controlled review fix",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "vc/review-undo",
          worktreePath: mode === "root" ? null : exclusive,
          createdBy: "user",
          creationSource: "web",
        });
        if (mode === "shared" || mode === "archived-shared")
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("review-other-create"),
            threadId: ThreadId.make("review-other"),
            projectId: ProjectId.make("review-project"),
            title: "Other review",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: "vc/review-undo",
            worktreePath: exclusive,
            createdBy: "user",
            creationSource: "web",
          });
        if (mode === "archived-shared")
          yield* orchestrator.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("archive-other-review"),
            threadId: ThreadId.make("review-other"),
          });
        // Finish the other thread's archive receipt before measuring rollback effects.
        yield* worker.drain();
        const marker = {
          id: EventId.make("review-started"),
          tone: "info" as const,
          kind: REVIEW_FIX_STARTED_ACTIVITY_KIND,
          summary: "Review fix started",
          payload: { reviewThreadId: "review-source", turnCountBefore: 0 },
          turnId: null,
          createdAt: DateTime.formatIso(now),
        };
        const providerThread = {
          id: providerThreadId,
          driver,
          providerInstanceId: instanceId,
          providerSessionId,
          appThreadId: threadId,
          ownerNodeId: null,
          nativeThreadRef: {
            driver,
            nativeId: "controlled-native-review",
            strength: "strong" as const,
          },
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        yield* sink.write({
          events: [
            {
              type: "provider-thread.updated",
              id: EventId.make("review-provider"),
              threadId,
              occurredAt: now,
              payload: providerThread,
            },
            {
              type: "run.created",
              id: EventId.make("review-run"),
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: runId,
                threadId,
                ordinal: 1,
                providerInstanceId: instanceId,
                modelSelection,
                providerThreadId,
                userMessageId: MessageId.make("review-fix-message"),
                rootNodeId: null,
                activeAttemptId: null,
                status: "completed",
                requestedAt: now,
                startedAt: now,
                completedAt: now,
                checkpointId: null,
                contextHandoffId: null,
              },
            },
            {
              type: "checkpoint-scope.created",
              id: EventId.make("review-scope"),
              threadId,
              occurredAt: now,
              payload: {
                id: scopeId,
                threadId,
                parentScopeId: null,
                nodeId,
                providerThreadId,
                runId: null,
                cwd,
                kind: "root_run",
                ordinalWithinParent: 0,
                advancesAppRunCount: true,
                createdAt: now,
              },
            },
            ...(
              [
                { id: checkpointId, appRunOrdinal: null, ref: baselineRef, ordinalWithinScope: 0 },
                {
                  id: CheckpointId.make("review-fix-after"),
                  appRunOrdinal: 1,
                  ref: postRef,
                  ordinalWithinScope: 1,
                },
              ] as const
            ).map((point) => ({
              type: "checkpoint.captured" as const,
              id: EventId.make(`review-point-${point.ordinalWithinScope}`),
              threadId,
              occurredAt: now,
              payload: {
                ...point,
                threadId,
                scopeId,
                runId: point.appRunOrdinal === null ? null : runId,
                nodeId,
                parentCheckpointId: point.appRunOrdinal === null ? null : checkpointId,
                status: "ready" as const,
                files: [],
                capturedAt: now,
              },
            })),
          ],
        });
        const thread = (yield* orchestrator.getThreadProjection(threadId)).thread;
        yield* sink.write({
          events: [
            {
              type: "thread.metadata-updated",
              id: EventId.make("review-active-provider"),
              threadId,
              occurredAt: now,
              payload: { ...thread, activeProviderThreadId: providerThreadId },
            },
          ],
        });
        const service = yield* ReviewFix.ReviewFixThread.pipe(
          Effect.provide(
            ReviewFix.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  Layer.mock(ThreadManagement.ThreadManagementService)({
                    getThreadProjection: orchestrator.getThreadProjection,
                    dispatch: orchestrator.dispatch,
                  }),
                  Layer.mock(ProjectionStore.ProjectionStoreV2)({
                    getThreadShell: (id) =>
                      orchestrator
                        .getThreadShell(id)
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProjectionStore.ProjectionStoreReadError({ threadId: id, cause }),
                          ),
                        ),
                  }),
                  Layer.mock(ReviewActivities.ReviewActivityStoreV2)({
                    list: () => Effect.succeed([marker]),
                  }),
                  Layer.mock(ProjectStore.ProjectStoreV2)({}),
                  Layer.mock(GitWorkflow.GitWorkflowService)({}),
                  ServerSettings.layerTest(),
                ),
              ),
            ),
          ),
        );
        if (mode === "exclusive") {
          assert.deepEqual(
            yield* service.undo({ threadId, commandId: CommandId.make("review-undo") }),
            { turnCount: 0, undoneTurns: 1 },
          );
          assert.isAbove(yield* worker.drain(), 0);
          assert.equal(yield* fs.readFileString(path.join(cwd, "calc.js")), original);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "rolled_back",
          );
          assert.equal(providerRollbacks, 1);
          // Another checkout's files are never part of this rewind.
          assert.equal(yield* fs.readFileString(path.join(repository, "calc.js")), original);
        } else {
          const failure = yield* service
            .undo({ threadId, commandId: CommandId.make("review-undo") })
            .pipe(Effect.flip);
          assert.equal(failure.stage, "revert");
          assert.include(failure.message, SHARED_WORKSPACE_RESTORE_MESSAGE);
          assert.equal(yield* worker.drain(), 0);
          assert.equal(yield* fs.readFileString(path.join(cwd, "calc.js")), fixed);
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "completed",
          );
          assert.equal(providerRollbacks, 0);
        }
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
