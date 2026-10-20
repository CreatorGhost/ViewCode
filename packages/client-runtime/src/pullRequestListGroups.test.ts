import { describe, expect, it } from "vite-plus/test";

import {
  isUpstreamPullRequestGroupKey,
  pullRequestProjectKeyOfGroup,
  splitUpstreamPullRequestGroups,
} from "./pullRequestListGroups.ts";

const row = (number: number, repository: string, upstream?: true, host = "github.com") => ({
  number,
  host,
  repository,
  ...(upstream ? { upstream } : {}),
});

describe("splitUpstreamPullRequestGroups", () => {
  it("puts a fork's upstream rows in their own group, named as the upstream's", () => {
    const groups = splitUpstreamPullRequestGroups([
      {
        key: "mac:viewcode",
        label: "ViewCode",
        entries: [row(16655, "pingdotgg/t3code", true), row(70, "CreatorGhost/ViewCode")],
      },
      { key: "mac:web", label: "acme/web", entries: [row(3, "acme/web")] },
    ]);
    expect(
      groups.map((group) => [
        group.key,
        group.repositoryLabel,
        group.entries.map((entry) => entry.number),
      ]),
    ).toEqual([
      ["mac:viewcode", "CreatorGhost/ViewCode", [70]],
      ["mac:viewcode:upstream", "pingdotgg/t3code (upstream)", [16655]],
      // A project already named after its repository needs no repository beside it.
      ["mac:web", null, [3]],
    ]);
    expect(groups.map((group) => pullRequestProjectKeyOfGroup(group.key))).toEqual([
      "mac:viewcode",
      "mac:viewcode",
      "mac:web",
    ]);
    expect(groups.map((group) => isUpstreamPullRequestGroupKey(group.key))).toEqual([
      false,
      true,
      false,
    ]);
  });

  it("names a repository on another host with its host", () => {
    const [group] = splitUpstreamPullRequestGroups([
      { key: "k", label: "API", entries: [row(1, "team/api", undefined, "github.acme.dev")] },
    ]);
    expect(group?.repositoryLabel).toBe("github.acme.dev/team/api");
  });
});
