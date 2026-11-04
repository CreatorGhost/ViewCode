import {
  ProviderDriverKind,
  type CommandCodeSettings,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { AgentScope } from "@t3tools/shared/AgentScope";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import {
  browserCliAvailable,
  withAgentDeviceEnvironment,
} from "@t3tools/provider-core/server/mcpSession";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import { summarizeNativeProtocolPayload } from "@t3tools/provider-core/server/nativeProtocolLogging";
import { AcpProviderCapabilitiesV2 } from "@t3tools/provider-acp/server/adapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { providerMessageTextWithAttachmentPaths } from "@t3tools/provider-core/server/attachmentPrompt";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import {
  buildCommandCodeTurnArgs,
  resolveCommandCodeBinary,
  parseCommandCodeFrame,
  commandCodeRecord,
  parseCommandCodeUsage,
  commandCodeOutputText,
  type CommandCodeUsage,
} from "./commandCodeProtocol.ts";

export const COMMAND_CODE_DRIVER = ProviderDriverKind.make("commandCode");
const CommandCodeCapabilitiesV2 = {
  ...AcpProviderCapabilitiesV2,
  runtimePolicy: { enforcement: "native" },
  sessions: { ...AcpProviderCapabilitiesV2.sessions, supportsModelSwitchInSession: true },
  threads: { ...AcpProviderCapabilitiesV2.threads, canRollbackThread: false },
  turns: { ...AcpProviderCapabilitiesV2.turns, supportsSteeringByInterruptRestart: false },
  approvals: {
    ...AcpProviderCapabilitiesV2.approvals,
    supportsCommandApproval: false,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    approvalCallbacksAreLiveOnly: false,
  },
  planning: {
    ...AcpProviderCapabilitiesV2.planning,
    emitsPlanUpdated: false,
    emitsTodoList: false,
    supportsStructuredQuestions: false,
  },
  checkpointing: {
    ...AcpProviderCapabilitiesV2.checkpointing,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
  },
} satisfies OrchestrationV2ProviderCapabilities;

type Item = {
  readonly key: string;
  readonly ordinal: number;
  readonly kind:
    | "assistant_message"
    | "reasoning"
    | "dynamic_tool"
    | "command_execution"
    | "file_change";
  text: string;
  status: "running" | "completed" | "failed" | "cancelled" | "interrupted";
  readonly startedAt: DateTime.Utc;
  toolName?: string;
  input?: unknown;
  output?: unknown;
  fileName?: string | undefined;
};

export const makeCommandCodeAdapterV2 = Effect.fn("makeCommandCodeAdapterV2")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly settings: CommandCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const platform = yield* HostProcess.Platform;
  const ids = yield* IdAllocator.IdAllocatorV2;
  const host = yield* ProviderHost.ProviderHost;
  const driver = COMMAND_CODE_DRIVER;
  const agentScope = yield* AgentScope;
  const loggers = yield* Effect.serviceOption(ProviderEventLoggers.ProviderEventLoggers);
  const nativeLogger = Option.isSome(loggers) ? loggers.value.native : undefined;
  const providerMcpSessions = yield* Effect.serviceOption(McpProviderSessions.McpProviderSessions);
  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CommandCodeCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: (open) =>
      Effect.gen(function* () {
        const scope = yield* Effect.scope;
        const now = yield* DateTime.now;
        const session: OrchestrationV2ProviderSession = {
          id: open.providerSessionId,
          driver,
          providerInstanceId: options.instanceId,
          status: "ready",
          cwd: open.runtimePolicy.cwd ?? host.paths.cwd,
          model: open.modelSelection.model,
          capabilities: CommandCodeCapabilitiesV2,
          createdAt: now,
          updatedAt: now,
          lastError: null,
        };
        const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
        const emit = (event: ProviderAdapter.ProviderAdapterV2Event) =>
          Queue.offer(events, event).pipe(Effect.asVoid);
        let active:
          | {
              readonly turnId: string;
              readonly stop: Effect.Effect<void>;
              readonly done: Deferred.Deferred<void>;
            }
          | undefined;
        const histories = new Map<string, ProviderAdapter.ProviderAdapterV2HistoricalContext>();
        const nativeSessions = new Map<string, string>();
        const unsupported = (detail: string) =>
          Effect.fail(new ProviderAdapter.ProviderAdapterProtocolError({ driver, detail }));
        return {
          instanceId: options.instanceId,
          driver,
          providerSessionId: session.id,
          providerSession: session,
          events: Stream.fromEffectRepeat(Queue.take(events)),
          ensureThread: (input) =>
            Effect.gen(function* () {
              const createdAt = yield* DateTime.now;
              const nativeId = `viewcode-pending:${input.threadId}:${session.id}`;
              return {
                id: ids.derive.providerThread({
                  driver,
                  providerInstanceId: options.instanceId,
                  nativeThreadId: nativeId,
                }),
                driver,
                providerInstanceId: options.instanceId,
                providerSessionId: session.id,
                appThreadId: input.threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId, strength: "weak" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt,
                updatedAt: createdAt,
              } satisfies OrchestrationV2ProviderThread;
            }),
          resumeThread: ({ providerThread }) =>
            Effect.succeed({ ...providerThread, providerSessionId: session.id }),
          injectHistory: (input) =>
            Effect.sync(() => {
              histories.set(input.providerThread.id, input);
              return true;
            }),
          startTurn: (turn) =>
            Effect.gen(function* () {
              if (!options.settings.enabled) return yield* unsupported("Command Code is disabled.");
              if (active)
                return yield* unsupported(
                  "Command Code already has an active turn. Queue the next message.",
                );
              const startedAt = yield* DateTime.now;
              const nativeTurnId = `${options.instanceId}:${turn.attemptId}`;
              const providerTurnId = ids.derive.providerTurn({ driver, nativeTurnId });
              const items = new Map<string, Item>();
              const dirty = new Set<Item>();
              let segment = 0;
              let assistant: Item | undefined;
              let reasoning: Item | undefined;
              let result: Record<string, unknown> | undefined;
              let nativeSessionId =
                nativeSessions.get(turn.providerThread.id) ??
                turn.providerThread.nativeThreadRef?.nativeId ??
                undefined;
              if (nativeSessionId?.startsWith("viewcode-pending:")) nativeSessionId = undefined;
              let runError: string | undefined;
              let interrupted = false;
              let usage: CommandCodeUsage | undefined;
              let stderr = "";
              const done = yield* Deferred.make<void>();
              const history = histories.get(turn.providerThread.id);
              const context = [
                ...(history ? [{ key: "portable-history", text: history.context }] : []),
                ...(turn.appContext ?? []),
              ];
              const mcpSession = Option.isSome(providerMcpSessions)
                ? yield* providerMcpSessions.value.read(turn.threadId)
                : undefined;
              const prompt = [
                buildRuntimeInstructions({
                  harness: "Command Code",
                  model: turn.modelSelection.model,
                  browserCli: browserCliAvailable(mcpSession),
                }) +
                  "\n\nViewCode MCP tools are unavailable in this provider. Do not claim to call them.",
                ...context.map((entry) => entry.text),
                providerMessageTextWithAttachmentPaths({
                  text: turn.message.text,
                  attachments: turn.message.attachments,
                  resolveAttachmentPath: host.resolveAttachmentPath,
                }),
              ]
                .filter(Boolean)
                .join("\n\n");
              const binary = resolveCommandCodeBinary(options.settings.binaryPath, platform);
              const environment = withAgentDeviceEnvironment(options.environment, mcpSession);
              const command = yield* resolveSpawnCommand(
                binary,
                buildCommandCodeTurnArgs({
                  resumeSessionId: nativeSessionId,
                  model: turn.modelSelection.model,
                  fullAccess: turn.runtimePolicy.runtimeMode === "full-access",
                  addDirs: [host.paths.attachmentsDir],
                }),
                { env: environment },
              );
              const launch = yield* agentScope.wrap({
                command: command.command,
                args: command.args,
                name: "command-code",
                threadId: turn.threadId,
                env: environment,
              });
              const child = yield* spawner.spawn(
                ChildProcess.make(launch.command, launch.args, {
                  cwd: turn.runtimePolicy.cwd ?? session.cwd,
                  env: environment,
                  extendEnv: false,
                  shell: command.shell,
                }),
              );
              active = {
                turnId: providerTurnId,
                stop: child.kill({ forceKillAfter: "1 second" }).pipe(Effect.ignore),
                done,
              };
              const writeTurn = (
                status: "running" | "completed" | "failed" | "interrupted",
                completedAt: DateTime.Utc | null,
              ) =>
                emit({
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: providerTurnId,
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: { driver, nativeId: nativeTurnId, strength: "weak" },
                    ordinal: turn.providerTurnOrdinal,
                    status,
                    startedAt,
                    completedAt,
                    ...(usage
                      ? {
                          turnTokenUsage: {
                            usageScope: "main_agent",
                            usageStatus: "complete",
                            inputTokens: usage.inputTokens,
                            outputTokens: usage.outputTokens,
                            cachedInputTokens: usage.cacheReadTokens,
                            cacheCreationTokens: usage.cacheWriteTokens,
                            hasSubagents: false,
                          },
                          tokenUsage: {
                            usedTokens: usage.inputTokens + usage.outputTokens,
                            inputTokens: usage.inputTokens,
                            outputTokens: usage.outputTokens,
                            cachedInputTokens: usage.cacheReadTokens,
                            updatedAt: DateTime.formatIso(completedAt ?? startedAt),
                          },
                        }
                      : {}),
                  },
                });
              const flush = Effect.gen(function* () {
                for (const item of dirty) {
                  const updatedAt = yield* DateTime.now;
                  const nativeId = `${nativeTurnId}:${item.key}`;
                  const nativeItemRef = { driver, nativeId, strength: "weak" as const };
                  const nodeId = ids.derive.nodeFromProviderItem({
                    driver,
                    nativeItemId: nativeId,
                  });
                  const itemId = ids.derive.turnItemFromProviderItem({
                    driver,
                    nativeItemId: nativeId,
                  });
                  const completedAt = item.status === "running" ? null : updatedAt;
                  yield* emit({
                    type: "node.updated",
                    driver,
                    node: {
                      id: nodeId,
                      threadId: turn.threadId,
                      runId: turn.runId,
                      rootNodeId: turn.rootNodeId,
                      parentNodeId: turn.rootNodeId,
                      kind:
                        item.kind === "assistant_message"
                          ? "assistant_message"
                          : item.kind === "reasoning"
                            ? "reasoning"
                            : "tool_call",
                      status: item.status,
                      countsForRun: false,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      nativeItemRef,
                      runtimeRequestId: null,
                      checkpointScopeId: null,
                      startedAt: item.startedAt,
                      completedAt,
                    },
                  });
                  const base = {
                    id: itemId,
                    threadId: turn.threadId,
                    runId: turn.runId,
                    nodeId,
                    providerThreadId: turn.providerThread.id,
                    providerTurnId,
                    nativeItemRef,
                    parentItemId: null,
                    ordinal: item.ordinal,
                    status: item.status,
                    title: item.toolName ?? null,
                    startedAt: item.startedAt,
                    completedAt,
                    updatedAt,
                  };
                  let projected: OrchestrationV2TurnItem;
                  if (item.kind === "assistant_message") {
                    const messageId = ids.derive.messageFromProviderItem({
                      driver,
                      nativeItemId: nativeId,
                    });
                    yield* emit({
                      type: "message.updated",
                      driver,
                      message: {
                        id: messageId,
                        threadId: turn.threadId,
                        runId: turn.runId,
                        nodeId,
                        role: "assistant",
                        text: item.text,
                        attachments: [],
                        streaming: item.status === "running",
                        createdBy: "agent",
                        creationSource: "provider",
                        createdAt: item.startedAt,
                        updatedAt,
                      },
                    });
                    projected = {
                      ...base,
                      type: "assistant_message",
                      messageId,
                      text: item.text,
                      streaming: item.status === "running",
                    };
                  } else if (item.kind === "reasoning")
                    projected = {
                      ...base,
                      type: "reasoning",
                      text: item.text,
                      streaming: item.status === "running",
                    };
                  else if (item.kind === "command_execution")
                    projected = {
                      ...base,
                      type: "command_execution",
                      input:
                        typeof commandCodeRecord(item.input)?.command === "string"
                          ? String(commandCodeRecord(item.input)?.command)
                          : (item.toolName ?? "Command"),
                      ...(item.output === undefined
                        ? {}
                        : { output: commandCodeOutputText(item.output) }),
                    };
                  else if (item.kind === "file_change")
                    projected = {
                      ...base,
                      type: "file_change",
                      fileName: item.fileName ?? "unknown",
                      ...(typeof commandCodeRecord(item.input)?.old_string === "string"
                        ? { oldStr: String(commandCodeRecord(item.input)?.old_string) }
                        : {}),
                      ...(typeof commandCodeRecord(item.input)?.new_string === "string"
                        ? { newStr: String(commandCodeRecord(item.input)?.new_string) }
                        : {}),
                    };
                  else
                    projected = {
                      ...base,
                      type: "dynamic_tool",
                      toolName: item.toolName ?? null,
                      input: item.input,
                      ...(item.output === undefined ? {} : { output: item.output }),
                    };
                  yield* emit({ type: "turn_item.updated", driver, turnItem: projected });
                }
                dirty.clear();
              });
              const closeText = () => {
                for (const item of [assistant, reasoning])
                  if (item) {
                    item.status = "completed";
                    dirty.add(item);
                  }
                assistant = undefined;
                reasoning = undefined;
              };
              const makeItem = (key: string, kind: Item["kind"]): Item => {
                const item: Item = {
                  key,
                  kind,
                  ordinal: turn.providerTurnOrdinal * 100_000 + items.size + 1,
                  text: "",
                  status: "running",
                  startedAt,
                };
                items.set(key, item);
                dirty.add(item);
                return item;
              };
              const accept = (frame: Record<string, unknown>) => {
                if (frame.type === "result") {
                  result = frame;
                  usage = parseCommandCodeUsage(frame.usage) ?? usage;
                  if (typeof frame.sessionId === "string") nativeSessionId = frame.sessionId;
                  if (
                    !assistant &&
                    typeof frame.finalText === "string" &&
                    ![...items.values()].some((item) => item.kind === "assistant_message")
                  ) {
                    assistant = makeItem(`assistant:${++segment}`, "assistant_message");
                    assistant.text = frame.finalText;
                  }
                  return;
                }
                if (frame.type === "run_start" && typeof frame.sessionId === "string")
                  nativeSessionId = frame.sessionId;
                if (frame.type === "run_error")
                  runError =
                    typeof frame.error === "string"
                      ? frame.error
                      : typeof commandCodeRecord(frame.error)?.message === "string"
                        ? String(commandCodeRecord(frame.error)?.message)
                        : "Command Code failed.";
                if (frame.type === "model_request_end") {
                  const next = parseCommandCodeUsage(frame.usage);
                  if (next)
                    usage = {
                      inputTokens: (usage?.inputTokens ?? 0) + next.inputTokens,
                      outputTokens: (usage?.outputTokens ?? 0) + next.outputTokens,
                      cacheReadTokens: (usage?.cacheReadTokens ?? 0) + next.cacheReadTokens,
                      cacheWriteTokens: (usage?.cacheWriteTokens ?? 0) + next.cacheWriteTokens,
                    };
                }
                if (frame.type === "text_delta" && typeof frame.delta === "string") {
                  if (reasoning) {
                    reasoning.status = "completed";
                    dirty.add(reasoning);
                    reasoning = undefined;
                  }
                  assistant ??= makeItem(`assistant:${++segment}`, "assistant_message");
                  assistant.text += frame.delta;
                  dirty.add(assistant);
                }
                if (frame.type === "thinking_delta" && typeof frame.delta === "string") {
                  reasoning ??= makeItem(`reasoning:${++segment}`, "reasoning");
                  reasoning.text += frame.delta;
                  dirty.add(reasoning);
                }
                if (frame.type === "message_end" || frame.type === "message_start") closeText();
                if (frame.type === "thinking_end" && reasoning) {
                  reasoning.status = "completed";
                  dirty.add(reasoning);
                  reasoning = undefined;
                }
                if (frame.type === "tool_queued" && typeof frame.toolCallId === "string") {
                  closeText();
                  const name = typeof frame.toolName === "string" ? frame.toolName : "Tool";
                  const kind = /shell|command|bash/i.test(name)
                    ? "command_execution"
                    : /^(edit_file|write_file)$/.test(name)
                      ? "file_change"
                      : "dynamic_tool";
                  const item = makeItem(`tool:${frame.toolCallId}`, kind);
                  item.toolName = name;
                  item.input = frame.input;
                  const input = commandCodeRecord(frame.input);
                  item.fileName =
                    typeof input?.file_path === "string"
                      ? input.file_path
                      : typeof input?.path === "string"
                        ? input.path
                        : undefined;
                }
                if (
                  typeof frame.toolCallId === "string" &&
                  [
                    "tool_completed",
                    "tool_errored",
                    "tool_denied",
                    "tool_hook_blocked",
                    "tool_update",
                  ].includes(String(frame.type))
                ) {
                  const item = items.get(`tool:${frame.toolCallId}`);
                  if (item) {
                    item.status =
                      frame.type === "tool_completed"
                        ? "completed"
                        : frame.type === "tool_update"
                          ? "running"
                          : frame.type === "tool_denied" || frame.type === "tool_hook_blocked"
                            ? "cancelled"
                            : "failed";
                    item.output = frame.result ?? frame.error ?? frame.hookOutput ?? frame.partial;
                    dirty.add(item);
                  }
                }
              };
              yield* writeTurn("running", null);
              const run = Effect.gen(function* () {
                const stderrFiber = yield* child.stderr.pipe(
                  Stream.decodeText(),
                  Stream.runForEach((text) =>
                    Effect.sync(() => {
                      stderr = (stderr + text).slice(-4096);
                    }),
                  ),
                  Effect.forkScoped,
                );
                const writer = yield* Stream.make(new TextEncoder().encode(prompt)).pipe(
                  Stream.run(child.stdin),
                  Effect.forkScoped,
                );
                yield* child.stdout.pipe(
                  Stream.decodeText(),
                  Stream.splitLines,
                  Stream.groupedWithin(256, "50 millis"),
                  Stream.runForEach((lines) =>
                    Effect.gen(function* () {
                      for (const line of lines) {
                        const frame = parseCommandCodeFrame(line);
                        if (frame) {
                          if (nativeLogger)
                            yield* nativeLogger
                              .write(
                                {
                                  provider: driver,
                                  protocol: "command-code.ndjson",
                                  kind: "protocol",
                                  providerSessionId: session.id,
                                  event: {
                                    type: frame.type,
                                    ...summarizeNativeProtocolPayload(frame),
                                  },
                                },
                                open.threadId,
                              )
                              .pipe(Effect.ignore);
                          accept(frame);
                        }
                      }
                      yield* flush;
                    }),
                  ),
                );
                const code = Number(yield* child.exitCode);
                yield* Fiber.join(stderrFiber);
                yield* Fiber.join(writer);
                return code;
              }).pipe(Effect.scoped);
              const finish = (code: number | undefined, cause?: unknown) =>
                Effect.gen(function* () {
                  closeText();
                  const failed =
                    !interrupted &&
                    (cause !== undefined ||
                      code !== 0 ||
                      result?.subtype === "error" ||
                      runError !== undefined ||
                      result === undefined);
                  const status = interrupted ? "interrupted" : failed ? "failed" : "completed";
                  for (const item of items.values())
                    if (item.status === "running") {
                      item.status = interrupted ? "interrupted" : "failed";
                      dirty.add(item);
                    }
                  yield* flush;
                  const completedAt = yield* DateTime.now;
                  yield* writeTurn(status, completedAt);
                  if (nativeSessionId) {
                    nativeSessions.set(turn.providerThread.id, nativeSessionId);
                    yield* emit({
                      type: "provider_thread.updated",
                      driver,
                      providerThread: {
                        ...turn.providerThread,
                        providerSessionId: session.id,
                        nativeThreadRef: { driver, nativeId: nativeSessionId, strength: "strong" },
                        status: "active",
                        firstRunOrdinal: turn.providerThread.firstRunOrdinal ?? turn.runOrdinal,
                        lastRunOrdinal: turn.runOrdinal,
                        updatedAt: completedAt,
                      },
                    });
                  }
                  if (!failed && !interrupted) histories.delete(turn.providerThread.id);
                  active = undefined;
                  yield* emit(
                    failed
                      ? {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId,
                          runOrdinal: turn.runOrdinal,
                          failureItemOrdinal: turn.providerTurnOrdinal * 100_000 + items.size + 1,
                          status: "failed",
                          failure: makeProviderFailure({
                            class: "provider_error",
                            message:
                              typeof result?.error === "string"
                                ? result.error
                                : (runError ??
                                  (stderr.trim() ||
                                    "Command Code exited without a successful result.")),
                            cause,
                          }),
                          threadDisposition: "reusable",
                        }
                      : {
                          type: "turn.terminal",
                          driver,
                          providerThreadId: turn.providerThread.id,
                          providerTurnId,
                          runOrdinal: turn.runOrdinal,
                          status: interrupted ? "interrupted" : "completed",
                          failure: null,
                          threadDisposition: "reusable",
                        },
                  );
                  yield* Deferred.succeed(done, undefined);
                });
              yield* run.pipe(
                Effect.matchEffect({
                  onFailure: (cause) => finish(undefined, cause),
                  onSuccess: (code) => finish(code),
                }),
                Effect.ensuring(Deferred.succeed(done, undefined)),
                Effect.forkIn(scope),
              );
              const previous = active;
              if (previous)
                active = {
                  ...previous,
                  stop: Effect.sync(() => {
                    interrupted = true;
                  }).pipe(Effect.andThen(previous.stop)),
                };
            }).pipe(
              Effect.provideService(Scope.Scope, scope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    runId: turn.runId,
                    providerThreadId: turn.providerThread.id,
                    cause,
                  }),
              ),
            ),
          steerTurn: (input) =>
            Effect.fail(
              new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
                driver,
                providerThreadId: input.providerThread.id,
              }),
            ),
          interruptTurn: (input) =>
            Effect.gen(function* () {
              const current = active;
              if (current?.turnId !== input.providerTurnId) return;
              yield* current.stop;
              yield* Deferred.await(current.done);
            }),
          respondToRuntimeRequest: () =>
            unsupported("Command Code headless turns have no interactive request channel."),
          readThreadSnapshot: () =>
            unsupported("Command Code does not expose conversation snapshots."),
          rollbackThread: () =>
            unsupported("Command Code cannot roll back its native conversation."),
          forkThread: () => unsupported("Command Code requires portable context for a fork."),
        } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }),
  });
});
