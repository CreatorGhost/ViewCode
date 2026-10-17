/**
 * CommandCodeAdapter — runs one headless `cmd -p` process per turn.
 *
 * The CLI has no long-lived protocol, so a "session" here is only the thread's
 * workspace, runtime mode, and the native session id that the next turn
 * resumes with `--resume`. Stopping a turn kills its process. See
 * `../commandCodeCli.ts` for the wire format.
 *
 * @module CommandCodeAdapter
 */
import {
  type CommandCodeSettings,
  EventId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import {
  buildCommandCodeTurnArgs,
  type CommandCodeEventDraft,
  makeCommandCodeTurnMapper,
  resolveCommandCodeBinary,
} from "../commandCodeCli.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { buildRuntimeInstructions } from "../RuntimeInstructions.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import type { EventNdjsonLogger } from "./EventNdjsonLogger.ts";

const PROVIDER = ProviderDriverKind.make("commandCode");
const STDERR_TAIL_CHARS = 4_000;

const ResumeCursor = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  sessionId: Schema.NonEmptyString,
});
const decodeResumeCursor = Schema.decodeUnknownOption(ResumeCursor);

type Adapter = ProviderAdapterShape<ProviderAdapterError>;

export interface CommandCodeAdapterOptions {
  readonly instanceId: ProviderInstanceId;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: EventNdjsonLogger;
}

interface ActiveTurn {
  readonly turnId: TurnId;
  readonly done: Deferred.Deferred<void>;
  kill: Effect.Effect<void> | undefined;
  interrupted: boolean;
}

interface SessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string;
  readonly lock: Semaphore.Semaphore;
  readonly turns: Array<{ id: TurnId; items: Array<unknown> }>;
  session: ProviderSession;
  nativeSessionId: string | undefined;
  activeTurn: ActiveTurn | undefined;
  stopped: boolean;
}

export const makeCommandCodeAdapter = Effect.fn("makeCommandCodeAdapter")(function* (
  settings: CommandCodeSettings,
  options: CommandCodeAdapterOptions,
) {
  const crypto = yield* Crypto.Crypto;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const serverConfig = yield* ServerConfig;
  const platform = yield* HostProcessPlatform;
  const ownerScope = yield* Effect.scope;
  const sessions = new Map<ThreadId, SessionContext>();
  const events = yield* PubSub.unbounded<ProviderRuntimeEvent>();
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(
      (cause) =>
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method: "crypto/randomUUIDv4",
          detail: "Could not create a Command Code id.",
          cause,
        }),
    ),
  );
  const binary = resolveCommandCodeBinary(settings.binaryPath, platform);

  const emitDraft = (context: SessionContext, turnId: TurnId | undefined) =>
    Effect.fnUntraced(function* (draft: CommandCodeEventDraft) {
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
    });

  const emitAll = (
    context: SessionContext,
    turnId: TurnId | undefined,
    drafts: ReadonlyArray<CommandCodeEventDraft>,
  ) => Effect.forEach(drafts, emitDraft(context, turnId), { discard: true });

  const requireSession = (threadId: ThreadId) => {
    const context = sessions.get(threadId);
    return context && !context.stopped
      ? Effect.succeed(context)
      : Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
  };

  const setNativeSessionId = (context: SessionContext, sessionId: string) =>
    Effect.gen(function* () {
      if (context.nativeSessionId === sessionId) return;
      context.nativeSessionId = sessionId;
      context.session = {
        ...context.session,
        resumeCursor: { schemaVersion: 1, sessionId },
        updatedAt: yield* nowIso,
      };
      yield* emitAll(context, undefined, [
        { type: "thread.started", payload: { providerThreadId: sessionId } },
      ]);
    });

  /** Stops the active turn's process and waits until its events are settled. */
  const interruptActiveTurn = (context: SessionContext) =>
    Effect.gen(function* () {
      const turn = context.activeTurn;
      if (!turn) return;
      turn.interrupted = true;
      if (turn.kill) yield* turn.kill;
      yield* Deferred.await(turn.done);
    });

  const stopContext = (context: SessionContext) =>
    Effect.gen(function* () {
      if (context.stopped) return;
      yield* interruptActiveTurn(context);
      context.stopped = true;
      if (sessions.get(context.threadId) === context) sessions.delete(context.threadId);
      yield* emitAll(context, undefined, [
        { type: "session.exited", payload: { exitKind: "graceful" } },
      ]);
    }).pipe(Effect.uninterruptible);

  const startSession: Adapter["startSession"] = Effect.fn("CommandCodeAdapter.startSession")(
    function* (input) {
      if (!settings.enabled) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "Enable Command Code in provider settings before starting a thread.",
        });
      }
      if (
        (input.provider !== undefined && input.provider !== PROVIDER) ||
        (input.providerInstanceId !== undefined &&
          input.providerInstanceId !== options.instanceId) ||
        (input.modelSelection !== undefined &&
          input.modelSelection.instanceId !== options.instanceId)
      ) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "startSession",
          issue: "The Command Code provider instance does not match the requested session.",
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
      const cursor = input.freshSession ? Option.none() : decodeResumeCursor(input.resumeCursor);
      const previous = sessions.get(input.threadId);
      if (previous) yield* stopContext(previous);

      const createdAt = yield* nowIso;
      const nativeSessionId = Option.getOrUndefined(Option.map(cursor, (value) => value.sessionId));
      const session: ProviderSession = {
        provider: PROVIDER,
        providerInstanceId: options.instanceId,
        threadId: input.threadId,
        cwd,
        status: "ready",
        runtimeMode: input.runtimeMode,
        ...(input.modelSelection?.model ? { model: input.modelSelection.model } : {}),
        ...(nativeSessionId
          ? { resumeCursor: { schemaVersion: 1, sessionId: nativeSessionId } }
          : {}),
        createdAt,
        updatedAt: createdAt,
      };
      const context: SessionContext = {
        threadId: input.threadId,
        cwd,
        lock: yield* Semaphore.make(1),
        turns: [],
        session,
        nativeSessionId,
        activeTurn: undefined,
        stopped: false,
      };
      sessions.set(input.threadId, context);
      yield* emitAll(context, undefined, [
        { type: "session.started", payload: {} },
        {
          type: "session.state.changed",
          payload: { state: "ready", reason: "Command Code session ready" },
        },
        ...(nativeSessionId
          ? [
              {
                type: "thread.started",
                payload: { providerThreadId: nativeSessionId },
              } satisfies CommandCodeEventDraft,
            ]
          : []),
      ]);
      return session;
    },
  );

  /** Runs one process to completion and settles the turn. Never fails. */
  const runTurn = (input: {
    readonly context: SessionContext;
    readonly turn: ActiveTurn;
    readonly args: ReadonlyArray<string>;
    readonly prompt: string;
    readonly sessionKnown: Deferred.Deferred<void>;
  }) =>
    Effect.gen(function* () {
      const { context, turn } = input;
      const mapper = makeCommandCodeTurnMapper({
        itemIdPrefix: turn.turnId,
        knownSessionId: context.nativeSessionId,
      });
      let stderr = "";
      const processScope = yield* Scope.make();

      const consume = Effect.gen(function* () {
        const spawnCommand = yield* resolveSpawnCommand(binary, input.args, {
          env: options.environment,
        });
        const handle = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: context.cwd,
            env: options.environment,
            shell: spawnCommand.shell,
            stdin: { stream: Stream.encodeText(Stream.make(input.prompt)) },
          }),
        );
        turn.kill = handle.kill({ forceKillAfter: "5 seconds" }).pipe(Effect.ignore);
        if (turn.interrupted) yield* turn.kill;
        const readStderr = handle.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stderr = (stderr + chunk).slice(-STDERR_TAIL_CHARS);
            }),
          ),
          Effect.ignore,
        );
        const readStdout = handle.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) =>
            Effect.gen(function* () {
              if (options.nativeEventLogger) {
                yield* options.nativeEventLogger.write(line, context.threadId);
              }
              yield* emitAll(context, turn.turnId, mapper.acceptLine(line));
              const sessionId = mapper.sessionId();
              if (sessionId) {
                yield* setNativeSessionId(context, sessionId);
                yield* Deferred.succeed(input.sessionKnown, undefined);
              }
            }),
          ),
        );
        yield* Effect.all([readStdout, readStderr], { concurrency: "unbounded", discard: true });
        return Number(yield* handle.exitCode);
      }).pipe(Effect.provideService(Scope.Scope, processScope));

      const exit = yield* Effect.exit(consume);
      yield* Scope.close(processScope, Exit.void);
      if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) {
        yield* Effect.logWarning("Command Code process failed.", {
          cause: Cause.pretty(exit.cause),
        });
      }
      const exitCode = Exit.isSuccess(exit) ? exit.value : null;
      const spawnFailure =
        Exit.isFailure(exit) && !turn.interrupted && stderr.trim().length === 0
          ? `Could not run the Command Code CLI (\`${binary}\`). Check that it is installed and on PATH.`
          : "";
      yield* emitAll(
        context,
        turn.turnId,
        mapper.finish({
          exitCode,
          interrupted: turn.interrupted,
          stderr: stderr || spawnFailure,
        }),
      );
      const finalSessionId = mapper.sessionId();
      if (finalSessionId) yield* setNativeSessionId(context, finalSessionId);
      const record = context.turns.find((entry) => entry.id === turn.turnId);
      const summary = { exitCode, interrupted: turn.interrupted };
      if (record) record.items.push(summary);
      else context.turns.push({ id: turn.turnId, items: [summary] });
      const failed = !turn.interrupted && exitCode !== 0;
      context.session = {
        ...context.session,
        status: failed ? "error" : "ready",
        activeTurnId: undefined,
        updatedAt: yield* nowIso,
      };
      context.activeTurn = undefined;
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logError("Command Code turn settlement failed.", { cause: Cause.pretty(cause) }),
      ),
      Effect.ensuring(
        Effect.all([
          Deferred.succeed(input.sessionKnown, undefined),
          Deferred.succeed(input.turn.done, undefined),
        ]),
      ),
      Effect.uninterruptible,
    );

  const sendTurn: Adapter["sendTurn"] = Effect.fn("CommandCodeAdapter.sendTurn")(function* (input) {
    const context = yield* requireSession(input.threadId);
    if (input.modelSelection && input.modelSelection.instanceId !== options.instanceId) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "The selected model belongs to another provider instance.",
      });
    }
    const text = input.input?.trim();
    if (!text) {
      return yield* new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation: "sendTurn",
        issue: "Command Code needs a prompt to start a turn.",
      });
    }

    const launched = yield* context.lock.withPermit(
      Effect.gen(function* () {
        if (context.activeTurn) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Command Code is still working. Stop the current turn before sending another.",
          });
        }
        const model = input.modelSelection?.model ?? context.session.model;
        const turnId = TurnId.make(yield* randomId);
        const turn: ActiveTurn = {
          turnId,
          done: yield* Deferred.make<void>(),
          kill: undefined,
          interrupted: false,
        };
        context.activeTurn = turn;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          ...(model ? { model } : {}),
          updatedAt: yield* nowIso,
        };
        // The CLI keeps the conversation, so runtime context goes in once.
        const prompt =
          context.nativeSessionId === undefined
            ? `${text}\n\n${buildRuntimeInstructions({ harness: "Command Code", model })}`
            : text;
        const args = buildCommandCodeTurnArgs({
          resumeSessionId: context.nativeSessionId,
          model,
          fullAccess: context.session.runtimeMode === "full-access",
          addDirs: [serverConfig.attachmentsDir],
        });
        const sessionKnown = yield* Deferred.make<void>();
        if (context.nativeSessionId !== undefined) {
          yield* Deferred.succeed(sessionKnown, undefined);
        }
        yield* emitAll(context, turnId, [
          { type: "turn.started", payload: model ? { model } : {} },
        ]);
        yield* runTurn({ context, turn, args, prompt, sessionKnown }).pipe(
          Effect.forkIn(ownerScope),
        );
        return { turnId, sessionKnown };
      }),
    );
    // A first turn persists its resume cursor only once the CLI names the
    // session, so wait for `run_start` (or the process ending) before returning.
    yield* Deferred.await(launched.sessionKnown);
    return {
      threadId: input.threadId,
      turnId: launched.turnId,
      ...(context.session.resumeCursor !== undefined
        ? { resumeCursor: context.session.resumeCursor }
        : {}),
    };
  });

  const interruptTurn: Adapter["interruptTurn"] = (threadId) =>
    requireSession(threadId).pipe(Effect.flatMap(interruptActiveTurn));

  const unsupportedRequest = (method: string, detail: string) =>
    Effect.fail(new ProviderAdapterRequestError({ provider: PROVIDER, method, detail }));

  const stopAll: Adapter["stopAll"] = () =>
    Effect.forEach([...sessions.values()], stopContext, { discard: true });
  yield* Effect.addFinalizer(() =>
    stopAll().pipe(Effect.ensuring(PubSub.shutdown(events)), Effect.ignore),
  );

  return {
    provider: PROVIDER,
    // Each turn is a new process started with the selected `--model`.
    capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
    startSession,
    sendTurn,
    interruptTurn,
    // Headless Command Code has no approval or question channel: without
    // full access it blocks writes and shell commands instead of asking.
    respondToRequest: () =>
      unsupportedRequest("respondToRequest", "Command Code does not ask for approvals headlessly."),
    respondToUserInput: () =>
      unsupportedRequest("respondToUserInput", "Command Code does not ask questions headlessly."),
    stopSession: (threadId) => requireSession(threadId).pipe(Effect.flatMap(stopContext)),
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
          issue: "Command Code does not support conversation rewind. Start a new thread instead.",
        }),
      ),
    streamEvents: Stream.fromPubSub(events),
  } satisfies Adapter;
});
