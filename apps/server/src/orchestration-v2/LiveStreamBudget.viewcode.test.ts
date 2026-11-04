import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { expect } from "vite-plus/test";

import { makeLiveStreamBudget, type RetainedLiveItem } from "./LiveStreamBudget.ts";
import { RPC_STREAM_CHUNK_MAX_BYTES } from "../rpcChunkBudget.ts";

// ViewCode: Quick connect's relay closes the whole socket on a message over 1 MiB.
it.effect("splits a backlog so no delivered batch reaches the relay's message limit", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const budget = yield* makeLiveStreamBudget();
      const queue = yield* Queue.unbounded<RetainedLiveItem<{ text: string }>>();
      // A slow reader's backlog: six 300 KB updates waiting for one pull.
      for (let index = 0; index < 6; index += 1) {
        yield* Queue.offer(queue, yield* budget.retain({ text: String(index).repeat(300_000) }));
      }
      const pull = yield* Stream.toPull(budget.deliver(Stream.fromQueue(queue)));
      const batches: Array<ReadonlyArray<{ text: string }>> = [];
      while (batches.flat().length < 6) batches.push(yield* pull);

      expect(batches.map((batch) => batch.length)).toEqual([1, 1, 1, 1, 1, 1]);
      expect(batches.flat().map((item) => item.text[0])).toEqual(["0", "1", "2", "3", "4", "5"]);
      for (const batch of batches) {
        expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(RPC_STREAM_CHUNK_MAX_BYTES);
      }
    }),
  ),
);
