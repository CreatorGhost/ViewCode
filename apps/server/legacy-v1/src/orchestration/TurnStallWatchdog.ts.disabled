import { CommandId, EventId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProviderService } from "../provider/Services/ProviderService.ts";
import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import {
  describeStall,
  findStalledTurns,
  nextStallCheckAt,
  recordTurnStallEvent,
  sessionStillOnTurn,
  type TurnStallState,
} from "./turnStall.ts";

export const TURN_STALL_ACTIVITY_KIND = "provider.turn.stalled";
/** How long an interrupted turn gets to settle before its session is stopped. */
export const TURN_STALL_INTERRUPT_GRACE_MS = 30_000;
/** How often threads shown as running are checked for a live provider session. */
export const ORPHANED_TURN_SWEEP_MS = 5 * 60 * 1_000;
const ORPHANED_TURN_ERROR =
  "The provider session for this turn is gone. Send a new message to continue.";

/**
 * Ends turns whose provider went silent (see `turnStall.ts`) and settles threads
 * still shown as running after their provider session disappeared. Both used to
 * leave a thread on "Working" until the user noticed and pressed stop.
 */
export class TurnStallWatchdog extends Context.Service<
  TurnStallWatchdog,
  { readonly start: () => Effect.Effect<void, never, Scope.Scope> }
>()("t3/orchestration/TurnStallWatchdog") {}

export const make = Effect.gen(function* () {
  const providers = yield* ProviderService;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const state: TurnStallState = new Map();
  const changed = yield* Queue.sliding<void>(1);
  const uuid = crypto.randomUUIDv4;
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

  const note = (
    threadId: ThreadId,
    turnId: string | undefined,
    summary: string,
    tone: "error" | "info",
  ) =>
    Effect.gen(function* () {
      const createdAt = yield* nowIso;
      yield* engine.dispatch({
        type: "thread.activity.append",
        commandId: CommandId.make(`server:turn-stall:${yield* uuid}`),
        threadId,
        activity: {
          id: EventId.make(yield* uuid),
          tone,
          kind: TURN_STALL_ACTIVITY_KIND,
          summary,
          payload: { detail: summary },
          turnId: turnId === undefined ? null : TurnId.make(turnId),
          createdAt,
        },
        createdAt,
      });
    });

  const endStalledTurn = (threadId: string, turnId: string | undefined, silentForMs: number) =>
    Effect.gen(function* () {
      const id = ThreadId.make(threadId);
      // The tracker can miss a turn's end (a session replaced without an exit
      // event): only a turn the projection still shows running gets the error.
      const current = yield* projections
        .getThreadShellById(id)
        .pipe(Effect.map(Option.getOrUndefined));
      if (!sessionStillOnTurn(current?.session, turnId)) return;
      yield* Effect.logWarning("provider turn stalled; interrupting", {
        threadId,
        turnId,
        silentForMs,
      });
      yield* note(id, turnId, describeStall(silentForMs), "error");
      yield* providers
        .interruptTurn({ threadId: id, ...(turnId ? { turnId: TurnId.make(turnId) } : {}) })
        .pipe(Effect.ignore);
      // An adapter whose stream is wedged may not honor the interrupt either.
      yield* Effect.sleep(Duration.millis(TURN_STALL_INTERRUPT_GRACE_MS));
      const thread = yield* projections
        .getThreadShellById(id)
        .pipe(Effect.map(Option.getOrUndefined));
      const active = thread?.session?.activeTurnId;
      if (active != null && (turnId === undefined || String(active) === turnId)) {
        yield* Effect.logWarning("stalled turn ignored interrupt; stopping session", {
          threadId,
          turnId,
        });
        yield* providers.stopSession({ threadId: id }).pipe(Effect.ignore);
      }
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("failed to end a stalled turn", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const checkLoop = Effect.gen(function* () {
    while (true) {
      const now = yield* Clock.currentTimeMillis;
      for (const stalled of findStalledTurns(state, now)) {
        // Drop it first so the next round does not act on the same turn twice.
        state.delete(stalled.threadId);
        yield* forkParked(endStalledTurn(stalled.threadId, stalled.turnId, stalled.silentForMs));
      }
      const next = nextStallCheckAt(state);
      if (next === null) yield* Queue.take(changed);
      else
        yield* Effect.raceFirst(
          Queue.take(changed),
          Effect.sleep(Duration.millis(Math.max(1_000, next - now))),
        );
    }
  });

  /** Threads the projection shows as busy while no adapter holds their session. */
  const sweepOrphans = Effect.gen(function* () {
    const live = new Set(
      (yield* providers.listSessions()).map((session) => String(session.threadId)),
    );
    const snapshot = yield* projections.getShellSnapshot();
    for (const thread of snapshot.threads) {
      const session = thread.session;
      if (session === null || live.has(String(thread.id))) continue;
      if (session.status !== "running" && session.activeTurnId === null) continue;
      // Re-read: a turn may have started between the two reads.
      const fresh = yield* projections
        .getThreadShellById(thread.id)
        .pipe(Effect.map(Option.getOrUndefined));
      const freshSession = fresh?.session;
      if (
        !freshSession ||
        (freshSession.status !== "running" && freshSession.activeTurnId === null)
      )
        continue;
      if ((yield* providers.listSessions()).some((s) => s.threadId === thread.id)) continue;
      const updatedAt = yield* nowIso;
      yield* Effect.logWarning("settling turn with no live provider session", {
        threadId: thread.id,
      });
      yield* engine.dispatch({
        type: "thread.session.set",
        commandId: CommandId.make(`server:orphaned-turn:${yield* uuid}`),
        threadId: thread.id,
        session: {
          ...freshSession,
          status: "error",
          activeTurnId: null,
          lastError: ORPHANED_TURN_ERROR,
          updatedAt,
        },
        createdAt: updatedAt,
      });
    }
  }).pipe(
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterruptsOnly(cause),
      (cause) => Effect.logWarning("orphaned turn sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start = Effect.fn("TurnStallWatchdog.start")(function* () {
    yield* forkParked(
      Stream.runForEach(providers.streamEvents, (event) =>
        Effect.gen(function* () {
          // Most events are deltas: O(1), and the loop is only woken when the
          // earliest deadline can move earlier.
          if (recordTurnStallEvent(state, event, yield* Clock.currentTimeMillis)) {
            yield* Queue.offer(changed, undefined);
          }
        }),
      ),
    );
    yield* forkParked(checkLoop);
    yield* forkParked(
      Effect.sleep(Duration.millis(ORPHANED_TURN_SWEEP_MS)).pipe(
        Effect.andThen(sweepOrphans),
        Effect.forever,
      ),
    );
  });

  return { start } satisfies TurnStallWatchdog["Service"];
});

export const layer = Layer.effect(TurnStallWatchdog, make);
