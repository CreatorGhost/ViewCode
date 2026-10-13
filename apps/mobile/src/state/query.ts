import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { use, useEffect } from "react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-environment-query:empty"),
);

export interface EnvironmentQueryView<A> {
  readonly data: A | null;
  readonly error: string | null;
  readonly isPending: boolean;
  readonly isSuccess: boolean;
  readonly refresh: () => void;
}

function formatError(cause: Cause.Cause<unknown>): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The environment request failed.";
}

export function useEnvironmentQuery<A, E>(
  atom: Atom.Atom<AsyncResult.AsyncResult<A, E>> | null,
): EnvironmentQueryView<A> {
  const registry = use(RegistryContext);
  const selectedAtom = atom ?? EMPTY_ASYNC_RESULT_ATOM;
  const result = useAtomValue(selectedAtom);
  const refresh = useAtomRefresh(selectedAtom);
  const interrupted = result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause);
  // An interrupted RPC has no answer. Keep prior data while one mounted reader retries it.
  // Other readers may have already restarted it before this render's effect runs.
  useEffect(() => {
    if (atom !== null && interrupted && !result.waiting && registry.get(selectedAtom) === result)
      refresh();
  }, [atom, interrupted, result, refresh, registry, selectedAtom]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error: result._tag === "Failure" && !interrupted ? formatError(result.cause) : null,
    isPending: atom !== null && (result.waiting || interrupted),
    isSuccess: result._tag === "Success",
    refresh,
  };
}
