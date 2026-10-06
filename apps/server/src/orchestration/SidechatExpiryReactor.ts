import { CommandId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";

import { forkParked } from "../serverActivation.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";
import { findExpiredSidechats } from "./sidechatExpiry.ts";

/** How often side chats are checked for idleness; expiry is measured in hours. */
export const SIDECHAT_EXPIRY_SWEEP_MS = 10 * 60 * 1_000;

/** Archives side chats that have been idle for a day (see `sidechatExpiry.ts`). */
export class SidechatExpiryReactor extends Context.Service<
  SidechatExpiryReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly sweep: Effect.Effect<void>;
  }
>()("t3/orchestration/SidechatExpiryReactor") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const projections = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const crypto = yield* Crypto.Crypto;

  const sweep = Effect.gen(function* () {
    const snapshot = yield* projections.getShellSnapshot();
    for (const thread of findExpiredSidechats(snapshot.threads, yield* Clock.currentTimeMillis)) {
      yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`server:sidechat-expiry:${yield* crypto.randomUUIDv4}`),
          threadId: thread.id,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to archive an expired side chat", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("side chat expiry sweep failed", { cause: Cause.pretty(cause) }),
    ),
  );

  const start = Effect.fn("SidechatExpiryReactor.start")(function* () {
    yield* forkParked(
      sweep.pipe(
        Effect.andThen(Effect.sleep(Duration.millis(SIDECHAT_EXPIRY_SWEEP_MS))),
        Effect.forever,
      ),
    );
  });

  return { start, sweep } satisfies SidechatExpiryReactor["Service"];
});

export const layer = Layer.effect(SidechatExpiryReactor, make);
