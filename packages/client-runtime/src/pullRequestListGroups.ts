import type { PullRequestListEntry } from "@t3tools/contracts";

type GroupedRow = Pick<PullRequestListEntry, "host" | "repository" | "upstream">;

const UPSTREAM_GROUP_SUFFIX = ":upstream";

/** The project group key an upstream group was split from; a project's own key is unchanged. */
export function pullRequestProjectKeyOfGroup(groupKey: string): string {
  return groupKey.endsWith(UPSTREAM_GROUP_SUFFIX)
    ? groupKey.slice(0, -UPSTREAM_GROUP_SUFFIX.length)
    : groupKey;
}

export function isUpstreamPullRequestGroupKey(groupKey: string): boolean {
  return groupKey.endsWith(UPSTREAM_GROUP_SUFFIX);
}

const repositoryName = (entry: GroupedRow) =>
  entry.host.toLowerCase() === "github.com"
    ? entry.repository
    : `${entry.host}/${entry.repository}`;

/**
 * A fork's project lists its own pull requests and its upstream's, and the project's name says
 * neither, so the upstream rows get their own group whose heading says whose rows they are.
 * The project's own group keeps its key, so its folded state carries over.
 */
export function splitUpstreamPullRequestGroups<
  Entry extends GroupedRow,
  Group extends {
    readonly key: string;
    readonly label: string;
    readonly entries: ReadonlyArray<Entry>;
  },
>(
  groups: ReadonlyArray<Group>,
): Array<Group & { readonly upstream: boolean; readonly repositoryLabel: string | null }> {
  return groups.flatMap((group) => {
    const own = group.entries.filter((entry) => entry.upstream !== true);
    const upstream = group.entries.filter((entry) => entry.upstream === true);
    const label = (entries: ReadonlyArray<Entry>, isUpstream: boolean) => {
      const names = [...new Set(entries.map(repositoryName))].filter(
        (name) => isUpstream || name.toLowerCase() !== group.label.toLowerCase(),
      );
      if (!isUpstream) return names.length === 0 ? null : names.join(", ");
      return names.length === 0 ? "upstream" : `${names.join(", ")} (upstream)`;
    };
    return [
      ...(own.length > 0 || upstream.length === 0
        ? [{ ...group, entries: own, upstream: false, repositoryLabel: label(own, false) }]
        : []),
      ...(upstream.length > 0
        ? [
            {
              ...group,
              key: `${group.key}${UPSTREAM_GROUP_SUFFIX}`,
              entries: upstream,
              upstream: true,
              repositoryLabel: label(upstream, true),
            },
          ]
        : []),
    ];
  });
}
