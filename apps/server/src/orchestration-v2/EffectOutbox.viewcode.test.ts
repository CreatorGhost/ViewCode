import { assert, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";

// ViewCode speak mode: a slow spoken summary must never hold back the thread's
// next turn, and summaries stay ordered among themselves.

const layer = EffectOutbox.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));

it.layer(layer)("EffectOutbox spoken summary lane", (it) => {
  it.effect("runs spoken summaries beside turn work and titles, one summary at a time", () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const commandId = CommandId.make("command:spoken-summary-lane");
      const threadId = ThreadId.make("thread:spoken-summary-lane");
      const summary = (suffix: string) => ({
        id: `effect:spoken-summary-lane:${suffix}`,
        commandId,
        threadId,
        request: {
          type: "spoken-summary.generate" as const,
          runId: RunId.make(`run:spoken-summary-lane:${suffix}`),
        },
      });
      yield* outbox.enqueue([
        summary("a"),
        {
          id: "effect:spoken-summary-lane:b-start",
          commandId,
          threadId,
          request: { type: "provider-turn.start", runId: RunId.make("run:spoken-summary-lane:b") },
        },
        {
          id: "effect:spoken-summary-lane:c-title",
          commandId,
          threadId,
          request: { type: "thread-title.generate", kind: { type: "regenerate" } },
        },
        summary("d"),
      ]);
      const claim = (workerId: string) =>
        outbox
          .claimNext({ workerId, leaseDurationMs: 30_000 })
          .pipe(Effect.map(Option.map((effect) => effect.id)));

      assert.deepEqual(yield* claim("summary-worker"), Option.some(summary("a").id));
      assert.deepEqual(
        yield* claim("turn-worker"),
        Option.some("effect:spoken-summary-lane:b-start"),
      );
      assert.deepEqual(
        yield* claim("title-worker"),
        Option.some("effect:spoken-summary-lane:c-title"),
      );
      assert.isTrue(Option.isNone(yield* claim("blocked-worker")));

      yield* outbox.succeed({ effectId: summary("a").id, workerId: "summary-worker" });
      assert.deepEqual(yield* claim("summary-worker"), Option.some(summary("d").id));
    }),
  );
});
