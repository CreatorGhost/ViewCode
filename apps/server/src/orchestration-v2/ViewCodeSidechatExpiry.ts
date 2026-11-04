import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import { forkParked } from "../serverActivation.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { findExpiredSidechats, SIDECHAT_EXPIRY_SWEEP_MS } from "./viewcodeSidechatExpiryPolicy.ts";

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const terminals = yield* TerminalManager.TerminalManager;
  const started = yield* Ref.make(false);
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const snapshot = yield* threads.getShellSnapshot({ location: "active" });
    for (const candidate of findExpiredSidechats(snapshot.threads, now)) {
      const current = yield* threads.getThreadShell(candidate.id);
      if (current === null || findExpiredSidechats([current], now).length === 0) continue;
      yield* threads
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`server:sidechat-expiry:${yield* crypto.randomUUIDv4()}`),
          threadId: current.id,
          expectedUpdatedAt: current.updatedAt,
        })
        .pipe(
          Effect.andThen(terminals.close({ threadId: current.id })),
          Effect.catch((cause) =>
            Effect.logDebug("Side chat expiry did not archive this thread", {
              threadId: current.id,
              cause,
            }),
          ),
        );
    }
  }).pipe(Effect.catch((cause) => Effect.logWarning("Side chat expiry sweep failed", { cause })));
  return {
    sweep,
    start: () =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(started, true)) return;
        yield* forkParked(
          sweep.pipe(Effect.andThen(Effect.sleep(SIDECHAT_EXPIRY_SWEEP_MS)), Effect.forever),
        );
      }),
  };
});
export class ViewCodeSidechatExpiry extends Context.Service<
  ViewCodeSidechatExpiry,
  Effect.Success<typeof make>
>()("t3/orchestration-v2/ViewCodeSidechatExpiry") {}
export const layer = Layer.effect(ViewCodeSidechatExpiry, make);
