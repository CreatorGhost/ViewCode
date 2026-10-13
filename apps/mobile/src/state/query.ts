import { RegistryContext, useAtomRefresh, useAtomValue } from "@effect/atom-react";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/unstable/reactivity";
import { use, useCallback, useEffect } from "react";

const EMPTY_ASYNC_RESULT_ATOM = Atom.make(AsyncResult.initial<never, never>(false)).pipe(
  Atom.withLabel("mobile-environment-query:empty"),
);

// Share the retry budget across readers without retaining registries or query atoms.
const interruptedQueryRetries = new WeakMap<
  AtomRegistry.AtomRegistry,
  WeakSet<Atom.Atom<unknown>>
>();

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
  const refreshAtom = useAtomRefresh(selectedAtom);
  let retried = interruptedQueryRetries.get(registry);
  if (retried === undefined) {
    retried = new WeakSet();
    interruptedQueryRetries.set(registry, retried);
  }
  const refresh = useCallback(() => {
    retried.delete(selectedAtom);
    refreshAtom();
  }, [retried, selectedAtom, refreshAtom]);
  const interrupted = result._tag === "Failure" && Cause.hasInterruptsOnly(result.cause);
  const recovering = interrupted && (result.waiting || !retried.has(selectedAtom));
  // Retry once per interrupted run. Success or an explicit retry restores the budget.
  useEffect(() => {
    if (atom === null || registry.get(selectedAtom) !== result) return;
    if (result._tag === "Success" && !result.waiting) {
      retried.delete(selectedAtom);
    } else if (recovering && !result.waiting && !retried.has(selectedAtom)) {
      retried.add(selectedAtom);
      refreshAtom();
    }
  }, [atom, recovering, result, refreshAtom, registry, selectedAtom, retried]);
  return {
    data: Option.getOrNull(AsyncResult.value(result)),
    error:
      result._tag === "Failure" && !recovering
        ? interrupted
          ? "The environment request was interrupted. Try again."
          : formatError(result.cause)
        : null,
    isPending: atom !== null && (result.waiting || recovering),
    isSuccess: result._tag === "Success",
    refresh,
  };
}
