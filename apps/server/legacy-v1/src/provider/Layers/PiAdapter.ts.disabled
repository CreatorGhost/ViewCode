/**
 * PiAdapter — the Pi coding agent (https://pi.dev) through `pi --mode rpc`,
 * one long-lived process per thread. See `../piRpc.ts` for the protocol and
 * `../piExtension.ts` for how ViewCode's tools and approvals get into Pi.
 *
 * The process loads the user's own Pi setup (settings, models, extensions,
 * skills, AGENTS.md), and Pi stores the session itself, so the session file
 * is the resume cursor. A turn ends only on `agent_settled`. A message sent
 * while a turn runs is a native `steer`.
 *
 * @module PiAdapter
 */
import {
  ApprovalRequestId,
  type CanonicalRequestType,
  EventId,
  PI_DEFAULT_MODEL,
  type PiSettings,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ProviderRuntimeEvent,
  type ProviderSession,
  RuntimeRequestId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import { viewcodeToolsUnavailableWarning } from "../acp/AcpMcpDiagnostics.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import {
  ensurePiExtension,
  piConfirmToolName,
  piMcpServerConfig,
  PI_MCP_SERVER_ENV,
  PI_RUNTIME_MODE_ENV,
} from "../piExtension.ts";
import {
  makePiTurnMapper,
  parsePiCompactCommand,
  parsePiModelSlug,
  piField,
  piString,
  PI_THINKING_OPTION_ID,
  type PiEventDraft,
  type PiRecord,
  type PiTurnMapper,
} from "../piRpc.ts";
import { makePiRpcConnection, type PiRpcConnection, type PiRpcError } from "../piRpcConnection.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("pi");
// Session start loads extensions, MCP servers and skills.
const PI_STARTUP_TIMEOUT_MS = 60_000;
// Compaction is a model call over the whole conversation.
const PI_COMPACT_TIMEOUT_MS = 10 * 60_000;

const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionFile: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);
const encodeJsonString = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

export interface PiAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly mapper: PiTurnMapper;
}

interface PendingDialog {
  /** Pi's `extension_ui_request` id, answered with `extension_ui_response`. */
  readonly piRequestId: string;
  readonly kind: "approval" | "user-input";
  readonly requestType: CanonicalRequestType;
  readonly turnId: TurnId | undefined;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly scope: Scope.Closeable;
  readonly connection: PiRpcConnection;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  readonly dialogs: Map<ApprovalRequestId, PendingDialog>;
  session: ProviderSession;
  model: string | undefined;
  thinkingLevel: string | undefined;
  contextWindow: number | undefined;
  activeTurn: ActiveTurn | undefined;
  instructionsSent: boolean;
  stopped: boolean;
}

function toolRequestType(toolName: string | undefined): CanonicalRequestType {
  if (toolName === "bash") return "command_execution_approval";
  if (toolName === "edit" || toolName === "write") return "file_change_approval";
  return "permission_approval";
}

export const makePiAdapter = Effect.fn("makePiAdapter")(function* (
  settings: PiSettings,
  options: PiAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const sessions = new Map<ThreadId, PiSessionContext>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const binary = settings.binaryPath.trim() || "pi";
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Pi id.",
          cause,
        }),
    ),
  );
  const rpcError = (method: string) => (cause: PiRpcError) =>
    new ProviderAdapterRequestError({ provider: PROVIDER, method, detail: cause.message, cause });

  const emit = (
    context: PiSessionContext,
    turnId: TurnId | undefined,
    drafts: ReadonlyArray<PiEventDraft>,
  ) =>
    Effect.forEach(
      drafts,
      (draft) =>
        Effect.gen(function* () {
          const eventId = yield* crypto.randomUUIDv4.pipe(Effect.orElseSucceed(() => undefined));
          if (eventId === undefined) return;
          // Drafts carry every field of their variant except the base stamps.
          const event = {
            ...draft,
            eventId: EventId.make(eventId),
            provider: PROVIDER,
            providerInstanceId: options.instanceId,
            threadId: context.threadId,
            createdAt: yield* nowIso,
            ...(turnId ? { turnId } : {}),
          } as ProviderRuntimeEvent;
          yield* PubSub.publish(events, event);
        }),
      { discard: true },
    );

  const requireSession = (
    threadId: ThreadId,
  ): Effect.Effect<PiSessionContext, ProviderAdapterSessionNotFoundError> => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  /** Selects the model and thinking level, skipping what Pi already has. */
  const applyModel = (
    context: PiSessionContext,
    model: string | undefined,
    selections: ReadonlyArray<ProviderOptionSelection> | undefined,
  ) =>
    Effect.gen(function* () {
      if (model && model !== PI_DEFAULT_MODEL && model !== context.model) {
        const parsed = parsePiModelSlug(model);
        if (!parsed) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "set_model",
            issue: `'${model}' is not a Pi model (expected provider/model).`,
          });
        }
        const data = yield* context.connection
          .request({ type: "set_model", ...parsed })
          .pipe(Effect.mapError(rpcError("set_model")));
        context.model = model;
        const contextWindow = piField(data, "contextWindow");
        context.contextWindow = typeof contextWindow === "number" ? contextWindow : undefined;
      }
      const level = selections?.find((option) => option.id === PI_THINKING_OPTION_ID)?.value;
      if (typeof level === "string" && level && level !== context.thinkingLevel) {
        yield* context.connection
          .request({ type: "set_thinking_level", level })
          .pipe(Effect.mapError(rpcError("set_thinking_level")));
        context.thinkingLevel = level;
      }
    });

  const settleTurn = (context: PiSessionContext, drafts: ReadonlyArray<PiEventDraft>) =>
    Effect.gen(function* () {
      const turn = context.activeTurn;
      if (!turn) return;
      context.activeTurn = undefined;
      yield* emit(context, turn.turnId, drafts);
      context.turns.push({ id: turn.turnId, items: [] });
      context.session = {
        ...context.session,
        status: "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
    });

  const openDialog = (context: PiSessionContext, record: PiRecord) =>
    Effect.gen(function* () {
      const piRequestId = piString(record, "id");
      const method = piString(record, "method");
      if (!piRequestId || !method) return;
      if (method === "notify") {
        const message = piString(record, "message");
        const level = piString(record, "notifyType");
        if (message && (level === "warning" || level === "error")) {
          yield* emit(context, context.activeTurn?.turnId, [
            { type: "runtime.warning", payload: { message } },
          ]);
        }
        return;
      }
      if (
        method !== "confirm" &&
        method !== "select" &&
        method !== "input" &&
        method !== "editor"
      ) {
        return;
      }
      const requestId = ApprovalRequestId.make(yield* randomId.pipe(Effect.orDie));
      const turnId = context.activeTurn?.turnId;
      const title = piString(record, "title") ?? "Pi needs your input";
      if (method === "confirm") {
        const toolName = piConfirmToolName(title);
        const requestType = toolRequestType(toolName);
        context.dialogs.set(requestId, { piRequestId, kind: "approval", requestType, turnId });
        const message = piString(record, "message");
        yield* emit(context, turnId, [
          {
            type: "request.opened",
            requestId: RuntimeRequestId.make(requestId),
            payload: {
              requestType,
              detail: title,
              // Pi's confirm is yes or no; nothing is remembered for the session.
              options: [
                { decision: "accept", label: "Allow" },
                { decision: "decline", label: "Deny" },
              ],
              ...(message ? { args: { toolName, input: message } } : {}),
            },
          },
        ]);
        return;
      }
      context.dialogs.set(requestId, {
        piRequestId,
        kind: "user-input",
        requestType: "tool_user_input",
        turnId,
      });
      const choices = piField(record, "options");
      yield* emit(context, turnId, [
        {
          type: "user-input.requested",
          requestId: RuntimeRequestId.make(requestId),
          payload: {
            questions: [
              {
                id: requestId,
                header: "Pi",
                question: title,
                options: (Array.isArray(choices) ? choices : [])
                  .filter(
                    (choice): choice is string => typeof choice === "string" && !!choice.trim(),
                  )
                  .map((choice) => ({ label: choice, description: "" })),
                allowCustomAnswer: method !== "select",
                multiSelect: false,
              },
            ],
          },
        },
      ]);
    });

  const handleRecord = (context: PiSessionContext, record: PiRecord) =>
    Effect.gen(function* () {
      if (options.nativeEventLogger) {
        yield* options.nativeEventLogger.write(record, context.threadId);
      }
      if (record.type === "extension_ui_request") return yield* openDialog(context, record);
      const turn = context.activeTurn;
      // Work outside a ViewCode turn (an extension's own run) is not shown.
      if (!turn) return;
      if (record.type === "agent_settled") {
        return yield* settleTurn(context, turn.mapper.settle(record.aborted === true));
      }
      yield* emit(context, turn.turnId, turn.mapper.accept(record));
    });

  /** Answers every open dialog as cancelled, so Pi's tools do not wait on a turn that ended. */
  const cancelDialogs = (context: PiSessionContext) =>
    Effect.forEach(
      [...context.dialogs.values()],
      (dialog) =>
        context.connection
          .send({ type: "extension_ui_response", id: dialog.piRequestId, cancelled: true })
          .pipe(Effect.ignore),
      { discard: true },
    ).pipe(Effect.tap(() => Effect.sync(() => context.dialogs.clear())));

  const stopContext = (context: PiSessionContext, exitKind: "graceful" | "error" = "graceful") =>
    Effect.gen(function* () {
      if (context.stopped) return;
      context.stopped = true;
      if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
      yield* Scope.close(context.scope, Exit.void);
      yield* emit(context, undefined, [{ type: "session.exited", payload: { exitKind } }]);
    }).pipe(Effect.uninterruptible);

  const startSession: Adapter["startSession"] = Effect.fn("PiAdapter.startSession")(
    function* (input) {
      if (
        (input.provider !== undefined && input.provider !== PROVIDER) ||
        (input.modelSelection !== undefined &&
          input.modelSelection.instanceId !== options.instanceId)
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "The Pi provider instance does not match the requested session.",
        });
      }
      const cwd = input.cwd?.trim();
      if (!cwd) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "The session requires a workspace directory.",
        });
      }
      const previous = sessions.get(input.threadId);
      if (previous) yield* stopContext(previous);

      const resumeFile = input.freshSession
        ? undefined
        : Option.getOrUndefined(
            Option.map(decodeResumeCursor(input.resumeCursor), (cursor) => cursor.sessionFile),
          );
      const extensionPath = yield* ensurePiExtension(serverConfig.stateDir).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Could not write ViewCode's Pi extension: ${cause.message}`,
              cause,
            }),
        ),
      );
      const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
      const environment: NodeJS.ProcessEnv = {
        ...McpProviderSession.withAgentDeviceEnvironment(options.environment, mcpSession),
        [PI_RUNTIME_MODE_ENV]: input.runtimeMode,
        ...(mcpSession
          ? { [PI_MCP_SERVER_ENV]: encodeJsonString(piMcpServerConfig(mcpSession)) }
          : {}),
      };

      const scope = yield* Scope.make("sequential");
      const started = yield* Effect.gen(function* () {
        const connection = yield* makePiRpcConnection({
          command: binary,
          args: [
            "--mode",
            "rpc",
            ...(resumeFile ? ["--session", resumeFile] : []),
            "--extension",
            extensionPath,
          ],
          cwd,
          env: environment,
        }).pipe(Effect.provideService(Scope.Scope, scope));
        const state = yield* connection.request({ type: "get_state" }, PI_STARTUP_TIMEOUT_MS);
        return { connection, state };
      }).pipe(
        Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        Effect.tapError(() => Scope.close(scope, Exit.void)),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: input.threadId,
              detail: `Pi did not start: ${cause.message}`,
              cause,
            }),
        ),
      );
      const { connection, state } = started;
      const activeModel = piField(state, "model");
      const sessionFile = piString(state, "sessionFile");
      const createdAt = yield* nowIso;
      const contextWindow = piField(activeModel, "contextWindow");
      const context: PiSessionContext = {
        threadId: input.threadId,
        scope,
        connection,
        turns: [],
        dialogs: new Map(),
        session: {
          provider: PROVIDER,
          providerInstanceId: options.instanceId,
          threadId: input.threadId,
          cwd,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
          ...(sessionFile ? { resumeCursor: { schemaVersion: 1, sessionFile } } : {}),
          createdAt,
          updatedAt: createdAt,
        },
        model:
          piString(activeModel, "provider") && piString(activeModel, "id")
            ? `${piString(activeModel, "provider")}/${piString(activeModel, "id")}`
            : undefined,
        thinkingLevel: piString(state, "thinkingLevel"),
        contextWindow: typeof contextWindow === "number" ? contextWindow : undefined,
        activeTurn: undefined,
        instructionsSent: false,
        stopped: false,
      };
      sessions.set(input.threadId, context);

      // Ends when Pi does: a turn it leaves open fails, and the session is gone.
      yield* Stream.fromQueue(connection.events).pipe(
        Stream.runForEach((record) => handleRecord(context, record)),
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (context.stopped || Cause.hasInterruptsOnly(cause)) return;
            const message = "Pi exited unexpectedly.";
            yield* settleTurn(context, [
              { type: "runtime.error", payload: { message, class: "provider_error" } },
              { type: "turn.completed", payload: { state: "failed", errorMessage: message } },
            ]);
            yield* stopContext(context, "error");
          }),
        ),
        Effect.forkIn(scope),
      );

      yield* applyModel(context, input.modelSelection?.model, input.modelSelection?.options).pipe(
        Effect.tapError(() => stopContext(context, "error")),
      );
      yield* emit(context, undefined, [
        { type: "session.started", payload: {} },
        { type: "session.state.changed", payload: { state: "ready", reason: "Pi session ready" } },
        ...(piString(state, "sessionId")
          ? [
              {
                type: "thread.started",
                payload: { providerThreadId: piString(state, "sessionId")! },
              } satisfies PiEventDraft,
            ]
          : []),
        ...(mcpSession
          ? []
          : [
              {
                type: "runtime.warning",
                payload: viewcodeToolsUnavailableWarning("Pi", { kind: "not-issued" }),
              } satisfies PiEventDraft,
            ]),
      ]);
      return context.session;
    },
  );

  const readImages = (attachments: Parameters<Adapter["sendTurn"]>[0]["attachments"]) =>
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
              method: "prompt",
              detail: `Invalid attachment id '${attachment.id}'.`,
            });
          }
          const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderAdapterRequestError({
                  provider: PROVIDER,
                  method: "prompt",
                  detail: cause.message,
                  cause,
                }),
            ),
          );
          return {
            type: "image",
            data: Buffer.from(bytes).toString("base64"),
            mimeType: attachment.mimeType,
          };
        }),
    );

  const beginTurn = (context: PiSessionContext, model: string | undefined) =>
    Effect.gen(function* () {
      const turnId = TurnId.make(yield* randomId);
      const turn: ActiveTurn = {
        turnId,
        mapper: makePiTurnMapper({ itemIdPrefix: turnId, contextWindow: context.contextWindow }),
      };
      context.activeTurn = turn;
      context.session = {
        ...context.session,
        status: "running",
        activeTurnId: turnId,
        ...(model ? { model } : {}),
        updatedAt: yield* nowIso,
      };
      yield* emit(context, turnId, [{ type: "turn.started", payload: model ? { model } : {} }]);
      return turn;
    });

  const sendTurn: Adapter["sendTurn"] = Effect.fn("PiAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    const selection =
      input.modelSelection?.instanceId === options.instanceId ? input.modelSelection : undefined;
    const text = input.input?.trim() ?? "";
    const images = yield* readImages(input.attachments);
    if (!text && images.length === 0) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Turn requires non-empty text or attachments.",
      });
    }
    const result = (turnId: TurnId) => ({
      threadId: input.threadId,
      turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    });

    // Pi folds a message sent mid-turn into the running work.
    if (context.activeTurn) {
      yield* context.connection
        .request({ type: "steer", message: text, ...(images.length > 0 ? { images } : {}) })
        .pipe(Effect.mapError(rpcError("steer")));
      return result(context.activeTurn.turnId);
    }

    const model = selection?.model ?? context.session.model;
    yield* applyModel(context, selection?.model, selection?.options);

    // RPC mode has no `/compact`; ViewCode's compaction command runs RPC `compact`.
    const compact = parsePiCompactCommand(text);
    if (compact) {
      const turn = yield* beginTurn(context, model);
      yield* context.connection
        .request({ type: "compact", ...compact }, PI_COMPACT_TIMEOUT_MS)
        .pipe(
          Effect.matchEffect({
            onFailure: (cause) =>
              settleTurn(context, [
                {
                  type: "runtime.error",
                  payload: { message: cause.message, class: "provider_error" },
                },
                {
                  type: "turn.completed",
                  payload: { state: "failed", errorMessage: cause.message },
                },
              ]),
            onSuccess: () => settleTurn(context, turn.mapper.settle(false)),
          }),
          Effect.forkIn(context.scope),
        );
      return result(turn.turnId);
    }

    const turn = yield* beginTurn(context, model);
    const mcpSession = McpProviderSession.readMcpProviderSession(input.threadId);
    // Pi keeps the conversation, so runtime context goes in once per process.
    const message =
      context.instructionsSent || text.startsWith("/")
        ? text
        : `${text}\n\n${buildRuntimeInstructions({
            harness: "Pi",
            model,
            computerUse: mcpSession?.computerUse,
            browserCli: mcpSession?.browserCli,
          })}`;
    const accepted = yield* context.connection
      .request({ type: "prompt", message, ...(images.length > 0 ? { images } : {}) })
      .pipe(
        Effect.tapError((cause) =>
          settleTurn(context, [
            { type: "turn.completed", payload: { state: "failed", errorMessage: cause.message } },
          ]),
        ),
        Effect.mapError(rpcError("prompt")),
      );
    context.instructionsSent = true;
    // An extension command or input handler consumed it; no run will settle.
    if (piString(accepted, "disposition") === "handled") {
      yield* settleTurn(context, turn.mapper.settle(false));
    }
    return result(turn.turnId);
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      yield* cancelDialogs(context);
      if (!context.activeTurn) return;
      yield* context.connection.request({ type: "abort" }).pipe(Effect.mapError(rpcError("abort")));
    });

  const respondToRequest: Adapter["respondToRequest"] = (threadId, requestId, decision) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const dialog = context.dialogs.get(requestId);
      if (!dialog || dialog.kind !== "approval") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending approval request: ${requestId}`,
        });
      }
      context.dialogs.delete(requestId);
      yield* context.connection
        .send(
          decision === "cancel"
            ? { type: "extension_ui_response", id: dialog.piRequestId, cancelled: true }
            : {
                type: "extension_ui_response",
                id: dialog.piRequestId,
                confirmed: decision !== "decline",
              },
        )
        .pipe(Effect.mapError(rpcError("extension_ui_response")));
      yield* emit(context, dialog.turnId, [
        {
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: dialog.requestType, decision },
        },
      ]);
    });

  const respondToUserInput: Adapter["respondToUserInput"] = (threadId, requestId, answers) =>
    Effect.gen(function* () {
      const context = yield* requireSession(threadId);
      const dialog = context.dialogs.get(requestId);
      if (!dialog || dialog.kind !== "user-input") {
        return yield* new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "extension_ui_response",
          detail: `Unknown pending user-input request: ${requestId}`,
        });
      }
      context.dialogs.delete(requestId);
      const answer = answers[requestId];
      const value = Array.isArray(answer) ? answer[0] : answer;
      yield* context.connection
        .send(
          typeof value === "string" && value.length > 0
            ? { type: "extension_ui_response", id: dialog.piRequestId, value }
            : { type: "extension_ui_response", id: dialog.piRequestId, cancelled: true },
        )
        .pipe(Effect.mapError(rpcError("extension_ui_response")));
      yield* emit(context, dialog.turnId, [
        {
          type: "user-input.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { answers },
        },
      ]);
    });

  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], (context) => stopContext(context), { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ensuring(PubSub.shutdown(events)), Effect.ignore),
  );

  return {
    provider: PROVIDER,
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    compaction: { type: "slash-command", command: "/compact" },
    startSession,
    sendTurn,
    interruptTurn,
    respondToRequest,
    respondToUserInput,
    stopSession: (threadId) =>
      requireSession(threadId).pipe(Effect.flatMap((context) => stopContext(context))),
    stopAll,
    listSessions: () =>
      Effect.sync(() =>
        [...sessions.values()]
          .filter((context) => !context.stopped)
          .map((context) => ({ ...context.session })),
      ),
    hasSession: (threadId) =>
      Effect.sync(() => sessions.has(threadId) && !sessions.get(threadId)?.stopped),
    readThread: (threadId) =>
      Effect.map(requireSession(threadId), (context) => ({ threadId, turns: context.turns })),
    rollbackThread: () =>
      Effect.fail(
        new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "rollbackThread",
          issue: "Pi threads cannot be rewound in ViewCode. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
