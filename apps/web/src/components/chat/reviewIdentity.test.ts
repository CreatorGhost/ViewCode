import { describe, expect, it } from "vite-plus/test";

import { pullRequestTitleFromReviewTitle, reviewHeadingText } from "./reviewIdentity";

describe("reviewHeadingText", () => {
  it("names a pull request by number and title, or by number alone", () => {
    expect(
      reviewHeadingText({ kind: "pull-request", number: 1615, title: "feat: wait for callbacks" }),
    ).toBe("PR #1615 · feat: wait for callbacks");
    expect(reviewHeadingText({ kind: "pull-request", number: 1810, title: null })).toBe("PR #1810");
  });

  it("names the chat's own changes", () => {
    expect(reviewHeadingText({ kind: "local" })).toBe("This chat's changes");
  });
});

describe("pullRequestTitleFromReviewTitle", () => {
  it("reads the title after the pull request's number in the review's name", () => {
    expect(
      pullRequestTitleFromReviewTitle(
        "Deep review: #1615 feat(playbooks): wait for callbacks",
        1615,
      ),
    ).toBe("feat(playbooks): wait for callbacks");
  });

  it("gives nothing for another number or no title", () => {
    expect(pullRequestTitleFromReviewTitle("Deep review: #1615 feat: x", 1810)).toBe(null);
    expect(pullRequestTitleFromReviewTitle("Deep review: #1615", 1615)).toBe(null);
  });
});
