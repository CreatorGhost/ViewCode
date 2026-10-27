/**
 * ViewCode guard: storage cleanup keeps a worktree whose `.git` file names a missing directory,
 * whichever wording Git uses for it. Git 2.56 changed that message, which turned the cleanup run
 * into a failure on every CI runner that picked up the new Git.
 */
import { describe, expect, it } from "vite-plus/test";

import { gitStderrMeansNoRepository } from "./storageCleanup.ts";

describe("gitStderrMeansNoRepository (ViewCode)", () => {
  it("reads both Git wordings for a worktree without a repository", () => {
    expect(
      gitStderrMeansNoRepository("fatal: not a git repository: /missing-git-directory\n"),
    ).toBe(true);
    expect(
      gitStderrMeansNoRepository(
        "fatal: gitfile does not point to a valid repository: /tmp/worktrees/feature/.git\n",
      ),
    ).toBe(true);
  });

  it("leaves other Git failures as failures", () => {
    expect(gitStderrMeansNoRepository("fatal: Unable to create 'index.lock': File exists.")).toBe(
      false,
    );
  });
});
