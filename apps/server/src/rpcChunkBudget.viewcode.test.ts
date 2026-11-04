import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import { RPC_STREAM_CHUNK_MAX_BYTES, splitByBytes } from "./rpcChunkBudget.ts";
import { rpcInitialItems } from "./rpcInitialItems.ts";

describe("splitByBytes", () => {
  it("keeps order, never empties a run and lets an oversized item travel alone", () => {
    expect(splitByBytes([3, 3, 3, 9, 1], (size) => size, 6)).toEqual([[3, 3], [3], [9], [1]]);
    expect(splitByBytes([], (size: number) => size, 6)).toEqual([]);
  });
});

describe("rpcInitialItems", () => {
  effectIt.effect("sends a large replay as several messages under the relay limit", () =>
    Effect.gen(function* () {
      // A resume replay of 128 events can hold a megabyte of agent text.
      const replay = Array.from({ length: 128 }, (_, sequence) => ({
        kind: "event",
        sequence,
        text: "y".repeat(8_000),
      }));
      const chunks = yield* Stream.runCollect(Stream.chunks(rpcInitialItems(replay)));

      expect(chunks.length).toBeGreaterThan(1);
      expect(chunks.flat()).toEqual(replay);
      for (const chunk of chunks) {
        expect(Buffer.byteLength(JSON.stringify(chunk))).toBeLessThanOrEqual(
          RPC_STREAM_CHUNK_MAX_BYTES,
        );
      }
    }),
  );
});
