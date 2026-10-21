import {
  EnvironmentAuthorizationError,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  type EnvironmentId,
  type ClientGuardedRpcTag,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof WS_METHODS.subscribeAgentControl
  | typeof WS_METHODS.subscribeVoiceModels
  | typeof WS_METHODS.codexAuthCallbackSubscribe
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeCommandOutput
  | typeof ORCHESTRATION_V2_WS_METHODS.searchThreadStream
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.scheduledTasksSubscribe
  | typeof WS_METHODS.serverGetStorageCleanupReport
  | typeof WS_METHODS.serverGetDatabaseStorage
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeDeviceState
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.pullRequestsSubscribeRefreshes
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.subscribeWorktreeSetup
  | typeof WS_METHODS.subscribeProjectClones
  | typeof WS_METHODS.terminalAttach
  | typeof WS_METHODS.terminalObserve;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.chatGptHandoffSubscribe
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

const MAX_EXPECTED_FAILURE_RETRY_DELAY_MS = 30_000;

/** WebSocket close code for a message over the receiver's size limit (RFC 6455). */
const MESSAGE_TOO_BIG_CLOSE_CODE = 1009;
const MESSAGE_TOO_BIG_FIRST_HOLD_MS = 60_000;
const MESSAGE_TOO_BIG_MAX_HOLD_MS = 15 * 60_000;

/**
 * Quick connect's relay closes the whole socket with 1009 when one message is
 * over its 1 MiB limit, and every request on the socket fails with that close.
 * A newer host names the request's method in the reason ("Message too big:
 * <tag>"); an older one does not, so `waitingForFirstValue` narrows it to
 * subscriptions still waiting for their opening snapshot or replay.
 */
export function isMessageTooBigFailure(
  cause: Cause.Cause<unknown>,
  tag: string,
  waitingForFirstValue: boolean,
): boolean {
  return cause.reasons.some((reason) => {
    if (reason._tag !== "Fail" || !isRpcClientError(reason.error)) return false;
    const close = reason.error.reason;
    if (close._tag !== "SocketCloseError" || close.code !== MESSAGE_TOO_BIG_CLOSE_CODE) {
      return false;
    }
    const named = /^Message too big: (\S+)$/.exec(close.closeReason ?? "")?.[1];
    return waitingForFirstValue && (named === undefined || named === tag);
  });
}

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const getInitialServerConfig = Effect.fn("EnvironmentRpc.getInitialServerConfig")(
  function* () {
    const session = yield* currentSession();
    return yield* session.initialConfig;
  },
);

/** Installed by the shared command boundary. A missing boundary denies protected writes. */
export class RpcPermissionGuard extends Context.Reference<{
  readonly authorize: (
    environmentId: EnvironmentId,
    method: string,
    input: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
}>("@t3tools/client-runtime/rpc/RpcPermissionGuard", {
  defaultValue: () => ({
    authorize: (_environmentId, method, input) => {
      const scope = clientRpcRequiredScopes(method, input)[0];
      return scope === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(scope),
              message: `This connection requires ${scope}.`,
            }),
          );
    },
  }),
}) {}

const authorizeRequest = Effect.fn("EnvironmentRpc.authorize")(function* (
  method: string,
  input: unknown,
) {
  if (clientRpcRequiredScopes(method, input).length === 0) return;
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const guard = yield* RpcPermissionGuard;
  yield* guard.authorize(supervisor.target.environmentId, method, input);
});

export const requestGuarded = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  const session = yield* currentSession();
  yield* authorizeRequest(tag, input);
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStreamGuarded<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  | EnvironmentRpcStreamFailure<TTag>
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    authorizeRequest(tag, input).pipe(
      Effect.andThen(currentSession()),
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  readonly onDefect?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
  /**
   * This subscription's opening data was too big for the connection (see
   * `isMessageTooBigFailure`). Resubscribing at once would close the socket
   * again for every other request, so the subscription waits a minute, then
   * longer, before trying again; a `resubscribe` signal (the app returning to
   * the foreground) tries at once.
   */
  readonly onMessageTooBig?: Effect.Effect<void>;
}

function subscribeDynamicMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  mapStream: (
    session: RpcSession,
    stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  ) => Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  A,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      let messageTooBigStrikes = 0;
      let holdUntil = 0;
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() =>
                  Effect.sync(() => {
                    holdUntil = 0;
                  }).pipe(Effect.andThen(SubscriptionRef.get(supervisor.session))),
                ),
              ),
            );
      const waitOutHold = Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) =>
          holdUntil > now ? Effect.sleep(Duration.millis(holdUntil - now)) : Effect.void,
        ),
      );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              let expectedFailureRetries = 0;
              let waitingForFirstValue = true;
              const subscribeToSession = (): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>> =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      yield* waitOutHold;
                      waitingForFirstValue = true;
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      const stream = mapStream(session, method(input)).pipe(
                        Stream.onFirst(() =>
                          Effect.sync(() => {
                            expectedFailureRetries = 0;
                            waitingForFirstValue = false;
                            messageTooBigStrikes = 0;
                          }),
                        ),
                      );
                      return stream.pipe(Stream.ensuring(completeObservation));
                    }),
                  ).pipe(
                    Stream.tapCause((cause) =>
                      options?.onDefect !== undefined &&
                      cause.reasons.some(
                        (reason) =>
                          reason._tag === "Die" ||
                          (reason._tag === "Fail" &&
                            isRpcClientError(reason.error) &&
                            reason.error.reason._tag === "RpcClientDefect"),
                      )
                        ? options.onDefect(cause)
                        : Effect.void,
                    ),
                    Stream.catchCause((cause) => {
                      const hasOnlyExpectedFailures =
                        cause.reasons.length > 0 &&
                        cause.reasons.every((reason) => reason._tag === "Fail");
                      const isTransportFailure =
                        hasOnlyExpectedFailures &&
                        cause.reasons.every(
                          (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                        );
                      const onMessageTooBig = options?.onMessageTooBig;
                      if (
                        isTransportFailure &&
                        onMessageTooBig !== undefined &&
                        isMessageTooBigFailure(cause, tag, waitingForFirstValue)
                      ) {
                        return Stream.fromEffect(
                          Effect.gen(function* () {
                            messageTooBigStrikes += 1;
                            const holdMs = Math.min(
                              MESSAGE_TOO_BIG_FIRST_HOLD_MS * 2 ** (messageTooBigStrikes - 1),
                              MESSAGE_TOO_BIG_MAX_HOLD_MS,
                            );
                            holdUntil = (yield* Clock.currentTimeMillis) + holdMs;
                            yield* Effect.logWarning(
                              "A subscription's data was too big for the connection; holding it.",
                              {
                                method: tag,
                                environmentId: supervisor.target.environmentId,
                                holdMs,
                              },
                            );
                            yield* onMessageTooBig;
                          }),
                        ).pipe(Stream.drain);
                      }
                      if (isTransportFailure) {
                        return Stream.fromEffect(
                          Effect.logWarning(
                            "Durable RPC subscription lost its transport; waiting for the next session.",
                            {
                              cause: Cause.pretty(cause),
                              method: tag,
                              environmentId: supervisor.target.environmentId,
                            },
                          ),
                        ).pipe(Stream.drain);
                      }
                      if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        const isAuthorizationFailure = cause.reasons.some(
                          (reason) =>
                            reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
                        );
                        if (
                          options.retryExpectedFailureAfter === undefined ||
                          isAuthorizationFailure
                        ) {
                          return handled;
                        }
                        const retryDelay = Duration.millis(
                          Math.min(
                            Duration.toMillis(options.retryExpectedFailureAfter) *
                              2 ** expectedFailureRetries,
                            MAX_EXPECTED_FAILURE_RETRY_DELAY_MS,
                          ),
                        );
                        expectedFailureRetries += 1;
                        return handled.pipe(
                          Stream.concat(
                            Stream.fromEffect(Effect.sleep(retryDelay)).pipe(Stream.drain),
                          ),
                          Stream.concat(subscribeToSession()),
                        );
                      }
                      return Stream.failCause(cause);
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(tag, makeInput, (_session, stream) => stream, options);
}

/** Tags each value before `switchMap` can buffer it across a session change. */
export function subscribeDynamicWithSession<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  readonly [session: RpcSession, value: EnvironmentRpcStreamValue<TTag>],
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(
    tag,
    makeInput,
    (session, stream) => stream.pipe(Stream.map((value) => [session, value] as const)),
    options,
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

export const request = <TTag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => requestGuarded(tag, input);

export const runStream = <
  TTag extends Exclude<EnvironmentStreamCommandRpcTag, ClientGuardedRpcTag>,
>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => runStreamGuarded(tag, input);
