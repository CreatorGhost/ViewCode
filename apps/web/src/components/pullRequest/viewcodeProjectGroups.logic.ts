import { splitUpstreamPullRequestGroups } from "@t3tools/client-runtime/pull-request-list-groups";

import {
  groupPullRequestsByProject,
  type EnvironmentPullRequestEntry,
  type PullRequestGroup,
} from "./pullRequestList.logic";

/** Keep upstream's priority reads, but present their complete answer in ViewCode's folders. */
export function viewCodePullRequestProjectGroups(
  groups: ReadonlyArray<PullRequestGroup<EnvironmentPullRequestEntry>>,
  labels: ReadonlyMap<string, string>,
  text: string,
) {
  const entries = groups.flatMap((group) => group.entries);
  return splitUpstreamPullRequestGroups(
    groupPullRequestsByProject(
      text.length === 0
        ? entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
        : entries,
      labels,
    ),
  );
}

/** Keep every failed repository visible, including equally named projects on two servers. */
export function viewCodeUnreadableProjectReasons(
  errors: ReadonlyArray<{
    readonly environmentId: string;
    readonly projectTitle: string;
    readonly message: string;
  }>,
  environmentLabels: ReadonlyMap<string, string>,
) {
  const names = new Map<string, number>();
  for (const error of errors)
    names.set(error.projectTitle, (names.get(error.projectTitle) ?? 0) + 1);
  const reasons = new Map<string, string>();
  for (const error of errors) {
    const base =
      (names.get(error.projectTitle) ?? 0) > 1
        ? `${error.projectTitle} (${environmentLabels.get(error.environmentId) ?? error.environmentId})`
        : error.projectTitle;
    let name = base;
    for (let index = 2; reasons.has(name); index++) name = `${base} · ${index}`;
    reasons.set(name, error.message);
  }
  return reasons;
}
