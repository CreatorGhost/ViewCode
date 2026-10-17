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
  return groupPullRequestsByProject(
    text.length === 0
      ? entries.toSorted((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      : entries,
    labels,
  );
}
