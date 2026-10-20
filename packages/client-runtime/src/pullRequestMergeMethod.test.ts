import type { PullRequestMergeMethod } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  preferredPullRequestMergeMethod,
  resolvePullRequestDetailMergeMethod,
} from "./pullRequestMergeMethod";

const detail = (
  offered: ReadonlyArray<PullRequestMergeMethod>,
  enabled: Partial<Record<PullRequestMergeMethod, boolean>>,
) => ({
  capabilities: { mergeMethods: [...offered] },
  mergeCapabilities: { merge: false, squash: false, rebase: false, ...enabled },
});

describe("pull request merge method", () => {
  it("takes the first preference the repository allows", () => {
    expect(preferredPullRequestMergeMethod(["merge", "squash", "rebase"], [null, "rebase"])).toBe(
      "rebase",
    );
    expect(preferredPullRequestMergeMethod(["merge", "rebase"], ["squash", undefined])).toBe(
      "merge",
    );
  });

  it("never asks a squash-only repository for a merge commit", () => {
    const squashOnly = detail(["merge", "squash", "rebase"], { squash: true });
    expect(resolvePullRequestDetailMergeMethod(squashOnly, [undefined, "merge"])).toBe("squash");
  });

  it("refuses when the repository allows no method", () => {
    expect(() => resolvePullRequestDetailMergeMethod(detail(["merge"], {}), ["merge"])).toThrow(
      "No merge method is available for this repository.",
    );
  });
});
