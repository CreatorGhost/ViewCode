import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export interface ComputerUseTurnContext {
  readonly title: string;
  readonly turnId: TurnId;
  readonly provider: ProviderDriverKind;
  readonly fullAccess: boolean;
}
/** The computer gate reads current v2 ownership, never a provider's claimed thread or run. */
export class ComputerUseThreadState extends Context.Service<
  ComputerUseThreadState,
  {
    readonly running: (caller: {
      readonly threadId: ThreadId;
      readonly providerInstanceId: ProviderInstanceId;
    }) => Effect.Effect<ComputerUseTurnContext | undefined>;
    readonly activeTurn: (threadId: ThreadId) => Effect.Effect<TurnId | undefined>;
  }
>()("t3/computerUse/ComputerUseThreadState") {}

export const layer = Layer.effect(
  ComputerUseThreadState,
  Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    return ComputerUseThreadState.of({
      running: (caller) =>
        Effect.gen(function* () {
          const context = yield* projections.getThreadProviderContext(
            caller.threadId,
            caller.providerInstanceId,
          );
          const { run, providerThread } = yield* projections.getRunningTurnContext(caller.threadId);
          const thread = context.thread;
          if (
            thread.archivedAt !== null ||
            thread.deletedAt !== null ||
            run?.status !== "running" ||
            run.providerInstanceId !== caller.providerInstanceId ||
            providerThread?.providerInstanceId !== caller.providerInstanceId
          )
            return undefined;
          const session = context.providerSessions.find(
            (candidate) => candidate.id === providerThread.providerSessionId,
          );
          if (
            session === undefined ||
            session.providerInstanceId !== caller.providerInstanceId ||
            (session.status !== "running" && session.status !== "waiting")
          )
            return undefined;
          return {
            title: thread.title,
            turnId: TurnId.make(run.id),
            provider: session.driver,
            // A newly loosened thread setting must not upgrade an already running provider turn.
            fullAccess:
              thread.runtimeMode === "full-access" && run.viewcodeRuntimeMode === "full-access",
          };
        }).pipe(Effect.orElseSucceed(() => undefined)),
      activeTurn: (threadId) =>
        projections.getRunningTurnContext(threadId).pipe(
          Effect.map(({ run }) => (run === undefined ? undefined : TurnId.make(run.id))),
          Effect.orElseSucceed(() => undefined),
        ),
    });
  }),
);
