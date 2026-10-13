/**
 * AcpAgentAdapter — one provider adapter for ACP agents that need nothing
 * beyond the protocol (Droid, Devin). Each provider supplies how to spawn its
 * runtime and how to apply a turn's model and mode; everything else (approvals,
 * events, resume, MCP attachment, runtime instructions) is shared here.
 *
 * Agents with protocol extensions of their own (Cursor, Grok, Antigravity)
 * keep their own adapters.
 *
 * @module AcpAgentAdapter
 */
import {
  ApprovalRequestId,
  EventId,
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderInteractionMode,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type RuntimeMode,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { viewcodeToolsUnavailableWarning } from "../acp/AcpMcpDiagnostics.ts";
import { acpComputerUseAllowOnceOption, mapAcpToAdapterError } from "../acp/AcpAdapterSupport.ts";
import {
  makeAcpAssistantItemEvent,
  makeAcpContentDeltaEvent,
  makeAcpPlanUpdatedEvent,
  makeAcpRequestOpenedEvent,
  makeAcpRequestResolvedEvent,
  makeAcpToolCallEvent,
} from "../acp/AcpCoreRuntimeEvents.ts";
import { makeAcpNativeLoggerFactory } from "../acp/AcpNativeLogging.ts";
import { parsePermissionRequest } from "../acp/AcpRuntimeModel.ts";
import type * as AcpSessionRuntime from "../acp/AcpSessionRuntime.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type {
  ProviderAdapterCapabilities,
  ProviderAdapterShape,
  ProviderCompaction,
} from "../Services/ProviderAdapter.ts";
import { type EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const encodeUnknownJsonStringExit = Schema.encodeUnknownExit(Schema.fromJsonString(Schema.Unknown));
const RESUME_SCHEMA_VERSION = 1 as const;

type AcpRuntime = AcpSessionRuntime.AcpSessionRuntime["Service"];

/** What a provider's runtime factory gets for one session. */
export interface AcpAgentRuntimeInput extends Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "cwd" | "resumeSessionId" | "mcpServers" | "onMcpServersDropped" | "clientInfo"
> {
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly environment: NodeJS.ProcessEnv;
  readonly runtimeMode: RuntimeMode;
  readonly loggers: Pick<
    AcpSessionRuntime.AcpSessionRuntimeOptions,
    "requestLogger" | "protocolLogging"
  >;
}

/** A turn's model and mode, applied before every prompt. */
export interface AcpAgentSessionConfiguration {
  readonly runtime: AcpRuntime;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly model: string | undefined;
  readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
}

export interface AcpAgentProfile {
  readonly provider: ProviderDriverKind;
  /** Product name used in messages and as the runtime-instructions harness. */
  readonly label: string;
  readonly capabilities: ProviderAdapterCapabilities;
  readonly compaction?: ProviderCompaction<ProviderAdapterError>;
  readonly makeRuntime: (
    input: AcpAgentRuntimeInput,
  ) => Effect.Effect<AcpRuntime, EffectAcpErrors.AcpError, Crypto.Crypto | Scope.Scope>;
  readonly configureSession: (
    input: AcpAgentSessionConfiguration,
  ) => Effect.Effect<void, EffectAcpErrors.AcpError>;
  /** The ViewCode MCP server entry this agent takes, if any. */
  readonly mcpServer: (
    session: McpProviderSession.McpProviderSessionConfig,
  ) => EffectAcpSchema.McpServer | undefined;
}

export interface AcpAgentAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface PendingApproval {
  readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
}

interface AcpAgentSessionContext {
  readonly threadId: ThreadId;
  session: ProviderSession;
  readonly scope: Scope.Closeable;
  readonly acp: AcpRuntime;
  readonly pendingApprovals: Map<ApprovalRequestId, PendingApproval>;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  lastPlanFingerprint: string | undefined;
  activeTurnId: TurnId | undefined;
  promptInFlight: boolean;
  stopped: boolean;
}

function encodeJsonStringForDiagnostics(input: unknown): string | undefined {
  const result = encodeUnknownJsonStringExit(input);
  return Exit.isSuccess(result) ? result.value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseAcpAgentResume(raw: unknown): { sessionId: string } | undefined {
  if (!isRecord(raw)) return undefined;
  if (raw.schemaVersion !== RESUME_SCHEMA_VERSION) return undefined;
  if (typeof raw.sessionId !== "string" || !raw.sessionId.trim()) return undefined;
  return { sessionId: raw.sessionId.trim() };
}

/** The option an agent offered that matches a decision; agents pick their own option ids. */
export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: ProviderApprovalDecision,
): string | undefined {
  const byKind = (kind: EffectAcpSchema.PermissionOptionKind) =>
    request.options.find((option) => option.kind === kind && option.optionId.trim())?.optionId;
  switch (decision) {
    case "acceptForSession":
      return byKind("allow_always") ?? byKind("allow_once");
    case "accept":
      return byKind("allow_once") ?? byKind("allow_always");
    default:
      return byKind("reject_once") ?? byKind("reject_always");
  }
}

export function makeAcpAgentAdapter(profile: AcpAgentProfile, options: AcpAgentAdapterOptions) {
  return Effect.gen(function* () {
    const PROVIDER = profile.provider;
    const boundInstanceId = options.instanceId;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const serverConfig = yield* Effect.service(ServerConfig);
    const crypto = yield* Crypto.Crypto;
    const nativeEventLogger = options.nativeEventLogger;
    const makeAcpNativeLoggers = yield* makeAcpNativeLoggerFactory();

    const sessions = new Map<ThreadId, AcpAgentSessionContext>();
    const threadLocksRef = yield* SynchronizedRef.make(new Map<string, Semaphore.Semaphore>());
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: `Failed to generate ${profile.label} runtime identifier.`,
            cause,
          }),
      ),
    );
    const makeEventStamp = () =>
      Effect.all({ eventId: Effect.map(randomUUIDv4, EventId.make), createdAt: nowIso });
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEventPubSub, event).pipe(Effect.asVoid);

    const getThreadSemaphore = (threadId: string) =>
      SynchronizedRef.modifyEffect(threadLocksRef, (current) =>
        Option.match(Option.fromNullishOr(current.get(threadId)), {
          onNone: () =>
            Semaphore.make(1).pipe(
              Effect.map((semaphore) => {
                const next = new Map(current);
                next.set(threadId, semaphore);
                return [semaphore, next] as const;
              }),
            ),
          onSome: (semaphore) => Effect.succeed([semaphore, current] as const),
        }),
      );
    const withThreadLock = <A, E, R>(threadId: string, effect: Effect.Effect<A, E, R>) =>
      Effect.flatMap(getThreadSemaphore(threadId), (semaphore) => semaphore.withPermit(effect));

    const settlePendingApprovals = (ctx: AcpAgentSessionContext) =>
      Effect.forEach(
        [...ctx.pendingApprovals.values()],
        (pending) => Deferred.succeed(pending.decision, "cancel").pipe(Effect.ignore),
        { discard: true },
      );

    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<AcpAgentSessionContext, ProviderAdapterSessionNotFoundError> => {
      const ctx = sessions.get(threadId);
      return !ctx || ctx.stopped
        ? Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }))
        : Effect.succeed(ctx);
    };

    const stopSessionInternal = (ctx: AcpAgentSessionContext) =>
      Effect.gen(function* () {
        if (ctx.stopped) return;
        ctx.stopped = true;
        yield* settlePendingApprovals(ctx);
        yield* Effect.ignore(Scope.close(ctx.scope, Exit.void));
        sessions.delete(ctx.threadId);
        yield* offerRuntimeEvent({
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: ctx.threadId,
          payload: { exitKind: "graceful" },
        });
      });

    const emitPlanUpdate = (
      ctx: AcpAgentSessionContext,
      event: Extract<AcpSessionRuntime.AcpSessionRuntimeEvent, { _tag: "PlanUpdated" }>,
    ) =>
      Effect.gen(function* () {
        const fingerprint = `${ctx.activeTurnId ?? "no-turn"}:${encodeJsonStringForDiagnostics(event.payload) ?? "[unserializable payload]"}`;
        if (ctx.lastPlanFingerprint === fingerprint) return;
        ctx.lastPlanFingerprint = fingerprint;
        yield* offerRuntimeEvent(
          makeAcpPlanUpdatedEvent({
            stamp: yield* makeEventStamp(),
            provider: PROVIDER,
            threadId: ctx.threadId,
            turnId: ctx.activeTurnId,
            payload: event.payload,
            source: "acp.jsonrpc",
            method: "session/update",
            rawPayload: event.rawPayload,
          }),
        );
      });

    const handleRuntimeEvent = (
      ctx: AcpAgentSessionContext,
      event: AcpSessionRuntime.AcpSessionRuntimeEvent,
    ) =>
      Effect.gen(function* () {
        switch (event._tag) {
          case "EventStreamBarrier":
            yield* Deferred.succeed(event.acknowledge, undefined);
            return;
          case "AssistantItemStarted":
          case "AssistantItemCompleted":
            yield* offerRuntimeEvent(
              makeAcpAssistantItemEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                itemId: event.itemId,
                lifecycle:
                  event._tag === "AssistantItemStarted" ? "item.started" : "item.completed",
              }),
            );
            return;
          case "PlanUpdated":
            yield* emitPlanUpdate(ctx, event);
            return;
          case "ContextWindowUpdated":
            yield* offerRuntimeEvent({
              type: "thread.token-usage.updated",
              ...(yield* makeEventStamp()),
              provider: PROVIDER,
              threadId: ctx.threadId,
              ...(ctx.activeTurnId ? { turnId: ctx.activeTurnId } : {}),
              payload: { usage: { usedTokens: event.usedTokens, maxTokens: event.maxTokens } },
              raw: { source: "acp.jsonrpc", method: "session/update", payload: event.rawPayload },
            });
            return;
          case "ToolCallUpdated":
            yield* offerRuntimeEvent(
              makeAcpToolCallEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                toolCall: event.toolCall,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          case "ThoughtDelta":
          case "ContentDelta":
            yield* offerRuntimeEvent(
              makeAcpContentDeltaEvent({
                stamp: yield* makeEventStamp(),
                provider: PROVIDER,
                threadId: ctx.threadId,
                turnId: ctx.activeTurnId,
                ...(event._tag === "ThoughtDelta"
                  ? { streamKind: "reasoning_text" as const }
                  : event.itemId
                    ? { itemId: event.itemId }
                    : {}),
                text: event.text,
                rawPayload: event.rawPayload,
              }),
            );
            return;
          default:
            return;
        }
      });

    const startSession: ProviderAdapterShape<ProviderAdapterError>["startSession"] = (input) =>
      withThreadLock(
        input.threadId,
        Effect.gen(function* () {
          if (input.provider !== undefined && input.provider !== PROVIDER) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            });
          }
          if (!input.cwd?.trim()) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: "cwd is required and must be non-empty.",
            });
          }
          const cwd = path.resolve(input.cwd.trim());
          const modelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const existing = sessions.get(input.threadId);
          if (existing && !existing.stopped) yield* stopSessionInternal(existing);

          const pendingApprovals = new Map<ApprovalRequestId, PendingApproval>();
          const sessionScope = yield* Scope.make("sequential");
          let sessionScopeTransferred = false;
          yield* Effect.addFinalizer(() =>
            sessionScopeTransferred ? Effect.void : Scope.close(sessionScope, Exit.void),
          );
          let ctx: AcpAgentSessionContext | undefined;

          const resumeSessionId = parseAcpAgentResume(input.resumeCursor)?.sessionId;
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          const mcpServer = mcpSession ? profile.mcpServer(mcpSession) : undefined;
          const warnViewcodeToolsMissing = (
            reason: Parameters<typeof viewcodeToolsUnavailableWarning>[1],
          ) =>
            Effect.gen(function* () {
              yield* offerRuntimeEvent({
                type: "runtime.warning",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                payload: viewcodeToolsUnavailableWarning(profile.label, reason),
              });
            }).pipe(Effect.ignore);

          const acp = yield* profile
            .makeRuntime({
              cwd,
              childProcessSpawner,
              environment: McpProviderSession.withAgentDeviceEnvironment(
                options.environment ?? process.env,
                mcpSession,
              ),
              runtimeMode: input.runtimeMode,
              clientInfo: { name: "t3-code", version: "0.0.0" },
              ...(resumeSessionId ? { resumeSessionId } : {}),
              ...(mcpServer ? { mcpServers: [mcpServer] } : {}),
              onMcpServersDropped: ({ unsupportedTransports }) =>
                warnViewcodeToolsMissing({ kind: "unsupported-transport", unsupportedTransports }),
              loggers: makeAcpNativeLoggers({
                nativeEventLogger,
                provider: PROVIDER,
                threadId: input.threadId,
              }),
            })
            .pipe(
              Effect.provideService(Crypto.Crypto, crypto),
              Effect.provideService(Scope.Scope, sessionScope),
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterProcessError({
                    provider: PROVIDER,
                    threadId: input.threadId,
                    detail: cause.message,
                    cause,
                  }),
              ),
            );

          const started = yield* Effect.gen(function* () {
            yield* acp.handleRequestPermission((params) =>
              Effect.gen(function* () {
                if (input.runtimeMode === "full-access") {
                  const optionId = selectAcpPermissionOptionId(params, "acceptForSession");
                  if (optionId !== undefined) {
                    return { outcome: { outcome: "selected" as const, optionId } };
                  }
                }
                const computerUseOptionId = acpComputerUseAllowOnceOption(input.threadId, params);
                if (computerUseOptionId !== undefined) {
                  return {
                    outcome: { outcome: "selected" as const, optionId: computerUseOptionId },
                  };
                }
                const permissionRequest = parsePermissionRequest(params);
                const requestId = ApprovalRequestId.make(
                  yield* crypto.randomUUIDv4.pipe(Effect.orDie),
                );
                const runtimeRequestId = RuntimeRequestId.make(requestId);
                const decision = yield* Deferred.make<ProviderApprovalDecision>();
                pendingApprovals.set(requestId, { decision });
                const stamp = () => makeEventStamp().pipe(Effect.orDie);
                yield* offerRuntimeEvent(
                  makeAcpRequestOpenedEvent({
                    stamp: yield* stamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    detail:
                      permissionRequest.detail ??
                      encodeJsonStringForDiagnostics(params)?.slice(0, 2000) ??
                      "[unserializable params]",
                    args: params,
                    source: "acp.jsonrpc",
                    method: "session/request_permission",
                    rawPayload: params,
                  }),
                );
                const resolved = yield* Deferred.await(decision);
                pendingApprovals.delete(requestId);
                yield* offerRuntimeEvent(
                  makeAcpRequestResolvedEvent({
                    stamp: yield* stamp(),
                    provider: PROVIDER,
                    threadId: input.threadId,
                    turnId: ctx?.activeTurnId,
                    requestId: runtimeRequestId,
                    permissionRequest,
                    decision: resolved,
                  }),
                );
                const optionId =
                  resolved === "cancel" ? undefined : selectAcpPermissionOptionId(params, resolved);
                return {
                  outcome:
                    optionId === undefined
                      ? ({ outcome: "cancelled" } as const)
                      : { outcome: "selected" as const, optionId },
                };
              }),
            );
            const startResult = yield* acp.start();
            if (!mcpServer) yield* warnViewcodeToolsMissing({ kind: "not-issued" });
            return startResult;
          }).pipe(
            Effect.mapError((error) =>
              mapAcpToAdapterError(PROVIDER, input.threadId, "session/start", error),
            ),
          );

          yield* profile
            .configureSession({
              runtime: acp,
              runtimeMode: input.runtimeMode,
              interactionMode: undefined,
              model: modelSelection?.model,
              options: modelSelection?.options,
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", error),
              ),
            );

          const now = yield* nowIso;
          const session: ProviderSession = {
            provider: PROVIDER,
            providerInstanceId: boundInstanceId,
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            model: modelSelection?.model,
            threadId: input.threadId,
            resumeCursor: { schemaVersion: RESUME_SCHEMA_VERSION, sessionId: started.sessionId },
            createdAt: now,
            updatedAt: now,
          };
          const context: AcpAgentSessionContext = {
            threadId: input.threadId,
            session,
            scope: sessionScope,
            acp,
            pendingApprovals,
            turns: [],
            lastPlanFingerprint: undefined,
            activeTurnId: undefined,
            promptInFlight: false,
            stopped: false,
          };
          ctx = context;

          // Forked into the session scope so the consumer outlives startSession.
          yield* Stream.runDrain(
            Stream.mapEffect(acp.getEvents(), (event) => handleRuntimeEvent(context, event)),
          ).pipe(
            Effect.catch((cause) =>
              Effect.logError(`Failed to process ${profile.label} runtime notification.`, {
                cause,
              }),
            ),
            Effect.forkIn(sessionScope),
          );
          sessions.set(input.threadId, context);
          sessionScopeTransferred = true;

          yield* offerRuntimeEvent({
            type: "session.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { resume: started.initializeResult },
          });
          yield* offerRuntimeEvent({
            type: "session.state.changed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { state: "ready", reason: `${profile.label} ACP session ready` },
          });
          yield* offerRuntimeEvent({
            type: "thread.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            payload: { providerThreadId: started.sessionId },
          });
          return session;
        }).pipe(Effect.scoped),
      );

    const readImageAttachments = (
      attachments: Parameters<
        ProviderAdapterShape<ProviderAdapterError>["sendTurn"]
      >[0]["attachments"],
    ) =>
      Effect.forEach(
        // Images go inline; ProviderService already put generic files' paths in the prompt.
        (attachments ?? []).filter((attachment) => attachment.type === "image"),
        (attachment) =>
          Effect.gen(function* () {
            const attachmentPath = resolveAttachmentPath({
              attachmentsDir: serverConfig.attachmentsDir,
              attachment,
            });
            if (!attachmentPath) {
              return yield* new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/prompt",
                detail: `Invalid attachment id '${attachment.id}'.`,
              });
            }
            const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "session/prompt",
                    detail: cause.message,
                    cause,
                  }),
              ),
            );
            return {
              type: "image",
              data: Buffer.from(bytes).toString("base64"),
              mimeType: attachment.mimeType,
            } satisfies EffectAcpSchema.ContentBlock;
          }),
      );

    const sendTurn: ProviderAdapterShape<ProviderAdapterError>["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(input.threadId);
        // Agents differ on a second prompt mid-turn, so clients wait for the
        // turn to end (`supportsTurnSteering: false`) and this refuses one.
        if (ctx.promptInFlight) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `${profile.label} is still working. Stop the current turn before sending another.`,
          });
        }
        ctx.promptInFlight = true;
        const turnId = TurnId.make(yield* randomUUIDv4);
        return yield* Effect.gen(function* () {
          const turnModelSelection =
            input.modelSelection?.instanceId === boundInstanceId ? input.modelSelection : undefined;
          const model = turnModelSelection?.model ?? ctx.session.model;
          yield* profile
            .configureSession({
              runtime: ctx.acp,
              runtimeMode: ctx.session.runtimeMode,
              interactionMode: input.interactionMode,
              model,
              options: turnModelSelection?.options,
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/set_config_option", error),
              ),
            );
          ctx.activeTurnId = turnId;
          ctx.lastPlanFingerprint = undefined;
          ctx.session = { ...ctx.session, activeTurnId: turnId, updatedAt: yield* nowIso };
          yield* offerRuntimeEvent({
            type: "turn.started",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: model ? { model } : {},
          });

          const rawPrompt = input.input?.trim() ?? "";
          const promptParts: Array<EffectAcpSchema.ContentBlock> = [
            ...(rawPrompt ? [{ type: "text" as const, text: rawPrompt }] : []),
            ...(yield* readImageAttachments(input.attachments)),
          ];
          if (promptParts.length === 0) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "sendTurn",
              issue: "Turn requires non-empty text or attachments.",
            });
          }
          const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
          // Slash commands parse the whole text, so they go without instructions.
          const result = yield* ctx.acp
            .prompt({
              prompt: /^\/[^\s/]+(?:\s|$)/.test(rawPrompt)
                ? promptParts
                : [
                    ...promptParts,
                    {
                      type: "text",
                      text: buildRuntimeInstructions({
                        harness: profile.label,
                        model,
                        computerUse: mcpSession?.computerUse,
                        browserCli: mcpSession?.browserCli,
                      }),
                    },
                  ],
            })
            .pipe(
              Effect.mapError((error) =>
                mapAcpToAdapterError(PROVIDER, input.threadId, "session/prompt", error),
              ),
            );
          yield* ctx.acp.drainEvents;

          ctx.turns.push({ id: turnId, items: [{ prompt: promptParts, result }] });
          ctx.session = {
            ...ctx.session,
            activeTurnId: turnId,
            updatedAt: yield* nowIso,
            ...(model ? { model } : {}),
          };
          yield* offerRuntimeEvent({
            type: "turn.completed",
            ...(yield* makeEventStamp()),
            provider: PROVIDER,
            threadId: input.threadId,
            turnId,
            payload: {
              state: result.stopReason === "cancelled" ? "cancelled" : "completed",
              stopReason: result.stopReason ?? null,
            },
          });
          return { threadId: input.threadId, turnId, resumeCursor: ctx.session.resumeCursor };
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              ctx.promptInFlight = false;
            }),
          ),
        );
      });

    const interruptTurn: ProviderAdapterShape<ProviderAdapterError>["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        yield* settlePendingApprovals(ctx);
        yield* Effect.ignore(ctx.acp.cancel);
      });

    const respondToRequest: ProviderAdapterShape<ProviderAdapterError>["respondToRequest"] = (
      threadId,
      requestId,
      decision,
    ) =>
      Effect.gen(function* () {
        const ctx = yield* requireSession(threadId);
        const pending = ctx.pendingApprovals.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/request_permission",
            detail: `Unknown pending approval request: ${requestId}`,
          });
        }
        yield* Deferred.succeed(pending.decision, decision);
      });

    const respondToUserInput: ProviderAdapterShape<ProviderAdapterError>["respondToUserInput"] = (
      threadId,
      requestId,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "user-input",
              detail: `${profile.label} has no pending question ${requestId}.`,
            }),
          ),
        ),
      );

    const readThread: ProviderAdapterShape<ProviderAdapterError>["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.map((ctx) => ({ threadId, turns: ctx.turns })));

    const rollbackThread: ProviderAdapterShape<ProviderAdapterError>["rollbackThread"] = (
      threadId,
    ) =>
      requireSession(threadId).pipe(
        Effect.flatMap(() =>
          Effect.fail(
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "thread/rollback",
              detail: `${profile.label} ACP sessions do not support provider-side rollback.`,
            }),
          ),
        ),
      );

    const stopSession: ProviderAdapterShape<ProviderAdapterError>["stopSession"] = (threadId) =>
      withThreadLock(threadId, requireSession(threadId).pipe(Effect.flatMap(stopSessionInternal)));

    yield* Effect.addFinalizer(() =>
      Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }).pipe(
        Effect.catch((cause) =>
          Effect.logError(`Failed to emit ${profile.label} session shutdown event.`, { cause }),
        ),
        Effect.tap(() => PubSub.shutdown(runtimeEventPubSub)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: profile.capabilities,
      ...(profile.compaction ? { compaction: profile.compaction } : {}),
      startSession,
      sendTurn,
      interruptTurn,
      readThread,
      rollbackThread,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => Array.from(sessions.values(), (c) => ({ ...c.session }))),
      hasSession: (threadId) =>
        Effect.sync(() => {
          const c = sessions.get(threadId);
          return c !== undefined && !c.stopped;
        }),
      stopAll: () => Effect.forEach(sessions.values(), stopSessionInternal, { discard: true }),
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderAdapterShape<ProviderAdapterError>;
  });
}
