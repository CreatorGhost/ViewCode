import { useAtomValue } from "@effect/atom-react";
import { createEnvironmentSessionAtoms } from "@t3tools/client-runtime/state/session";
import type { AuthEnvironmentScope, AuthSessionState, EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";

export const environmentSession = createEnvironmentSessionAtoms(connectionAtomRuntime);

const EMPTY_PREPARED_CONNECTION_ATOM = Atom.make(Option.none()).pipe(
  Atom.withLabel("mobile-prepared-connection:empty"),
);

export function usePreparedConnection(environmentId: EnvironmentId | null) {
  return useAtomValue(
    environmentId === null
      ? EMPTY_PREPARED_CONNECTION_ATOM
      : environmentSession.preparedConnectionValueAtom(environmentId),
  );
}

/** A session without a scope list predates scopes and is granted everything it authenticates. */
function sessionHasScope(
  result: AsyncResult.AsyncResult<AuthSessionState, unknown>,
  scope: AuthEnvironmentScope,
): boolean {
  const session = Option.getOrNull(AsyncResult.value(result));
  return (
    result._tag !== "Failure" &&
    session !== null &&
    session.authenticated &&
    (session.scopes === undefined || session.scopes.includes(scope))
  );
}

/** Whether this client's session on an environment grants a scope, cached across refreshes. */
const scopeAtomsByEnvironment = Atom.family((environmentId: EnvironmentId) =>
  Atom.family((scope: AuthEnvironmentScope) =>
    Atom.make((get) =>
      sessionHasScope(get(environmentSession.sessionStateAtom(environmentId)), scope),
    ),
  ),
);
export const environmentScopeAtom = (environmentId: EnvironmentId, scope: AuthEnvironmentScope) =>
  scopeAtomsByEnvironment(environmentId)(scope);

const NO_SCOPE_ATOM = Atom.make(false);

/** Uses the selected environment's grant, including cached scopes during a refresh. */
export function useEnvironmentScope(
  environmentId: EnvironmentId | null,
  scope: AuthEnvironmentScope,
): boolean {
  return useAtomValue(
    environmentId === null ? NO_SCOPE_ATOM : environmentScopeAtom(environmentId, scope),
  );
}
