import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Null follows all environments, including ones connected after the menu opened.
 * The menu ticks only "All" in that mode, so picking an environment from it
 * narrows to that one environment instead of excluding it.
 */
export function toggleUsageEnvironment(
  selected: ReadonlySet<EnvironmentId> | null,
  environments: readonly { readonly environmentId: EnvironmentId }[],
  toggledId: EnvironmentId,
): ReadonlySet<EnvironmentId> | null {
  const ids = environments.map(({ environmentId }) => environmentId);
  if (selected === null) {
    if (!ids.includes(toggledId)) return null;
    return ids.length === 1 ? null : new Set([toggledId]);
  }
  const next = new Set(ids.filter((id) => selected.has(id)));
  if (ids.includes(toggledId)) {
    if (next.has(toggledId)) next.delete(toggledId);
    else next.add(toggledId);
  }
  return ids.every((id) => next.has(id)) ? null : next;
}
