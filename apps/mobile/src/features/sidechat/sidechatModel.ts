import type { ModelSelection, ThreadId } from "@t3tools/contracts";

/** Creation can be acknowledged before the shell arrives. Never send a retry to an older chat. */
export function resolveSidechatWhileCreating<T extends { readonly id: ThreadId }>(
  active: T | null,
  createdThreadId: ThreadId | null,
) {
  return createdThreadId !== null && active?.id !== createdThreadId ? null : active;
}

/** A local pick overrides this side chat's model, then the parent's, as in the web dock. */
export function resolveSidechatModelSelection(input: {
  readonly picked: ModelSelection | null;
  readonly sidechatSelection: ModelSelection | null;
  readonly parentSelection: ModelSelection | null;
}) {
  return input.picked ?? input.sidechatSelection ?? input.parentSelection;
}
