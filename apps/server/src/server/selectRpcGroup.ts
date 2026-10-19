import * as RpcGroup from "effect/rpc/RpcGroup";
import type * as Rpc from "effect/rpc/Rpc";

/** Keep the original schemas, middleware and annotations when registering a subgroup. */
export function selectRpcGroup<R extends Rpc.Any, const Tags extends ReadonlyArray<R["_tag"]>>(
  group: RpcGroup.RpcGroup<R>,
  tags: Tags,
): RpcGroup.RpcGroup<Extract<R, { readonly _tag: Tags[number] }>> {
  const selected = new Set<string>(tags);
  const requests = [...group.requests.values()].filter(
    (rpc): rpc is Extract<R, { readonly _tag: Tags[number] }> => selected.has(rpc._tag),
  );
  return RpcGroup.make(...requests).annotateMerge(group.annotations);
}
