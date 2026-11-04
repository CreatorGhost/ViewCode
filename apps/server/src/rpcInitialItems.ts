import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { splitByBytes } from "./rpcChunkBudget.ts";

const jsonBytes = (value: unknown): number =>
  Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");

export function rpcInitialItems<A>(items: ReadonlyArray<A>): Stream.Stream<A> {
  let pending: ReadonlyArray<A> | undefined = items;
  return Stream.unwrap(
    Effect.sync(() => {
      const initial = pending;
      // concat keeps its initial stream definition alive during the live tail.
      // That definition must no longer own delivered snapshots or replay rows.
      pending = undefined;
      if (initial === undefined) return Stream.empty;
      // A replay batch would otherwise go out as one message (see rpcChunkBudget).
      return initial.length > 1
        ? Stream.fromArrays(...splitByBytes(initial, jsonBytes))
        : Stream.fromIterable(initial);
    }),
  );
}
