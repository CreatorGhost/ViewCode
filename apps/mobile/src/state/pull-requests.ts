import {
  createPullRequestEnvironmentAtoms,
  createPullRequestStackAtomFamily,
} from "@t3tools/client-runtime/state/pull-requests";
import { AuthOrchestrationOperateScope, type EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentScopeAtom } from "./session";

const atoms = createPullRequestEnvironmentAtoms(connectionAtomRuntime);

// ViewCode's server guards every pull request mutation with `orchestration:operate`
// (`apps/server/src/auth/RpcAuthorization.ts`). Upstream derives this per RPC method in
// client-runtime; the mobile PR screens only read it through `permissionAtom`.
const operatePermissionAtom = Atom.family((environmentId: EnvironmentId | null) =>
  environmentId === null
    ? Atom.make(false)
    : environmentScopeAtom(environmentId, AuthOrchestrationOperateScope),
);
const withPermission = <C extends object>(command: C) => ({
  ...command,
  permissionAtom: (environmentId: EnvironmentId | null) => operatePermissionAtom(environmentId),
});

export const composerPullRequests = {
  ...atoms,
  runAction: withPermission(atoms.runAction),
  comment: withPermission(atoms.comment),
  submitReview: withPermission(atoms.submitReview),
  replyToThread: withPermission(atoms.replyToThread),
  setThreadResolution: withPermission(atoms.setThreadResolution),
  requestReviewers: withPermission(atoms.requestReviewers),
  setFilesViewed: withPermission(atoms.setFilesViewed),
};
export const pullRequestStackAtom = createPullRequestStackAtomFamily(
  connectionAtomRuntime,
  composerPullRequests.refreshes,
);
