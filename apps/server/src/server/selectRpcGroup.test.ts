import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { Rpc, RpcGroup, RpcTest } from "effect/rpc";
import { selectRpcGroup } from "./selectRpcGroup.ts";

it.effect("serves unary and streaming calls through the original full protocol after separate registration", () => {
  const group = RpcGroup.make(
    Rpc.make("setup.echo", { payload: Schema.String, success: Schema.String }),
    Rpc.make("core.count", { success: Schema.Number, stream: true }),
  );
  const setup = selectRpcGroup(group, ["setup.echo"]);
  const core = group.omit("setup.echo");
  const handlers = group.of({ "setup.echo": (input) => Effect.succeed(input.toUpperCase()), "core.count": () => Stream.make(1, 2) });
  return Effect.gen(function* () {
    const client = yield* RpcTest.makeClient(group, { flatten: true });
    assert.equal(yield* client("setup.echo", "hello"), "HELLO");
    assert.deepEqual(yield* client("core.count", undefined).pipe(Stream.runCollect), [1, 2]);
  }).pipe(Effect.provide(Layer.merge(setup.toLayer(handlers), core.toLayer(handlers))));
});
