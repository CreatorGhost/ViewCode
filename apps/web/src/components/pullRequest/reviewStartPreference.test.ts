import { describe, expect, it } from "vite-plus/test";

import {
  parseReviewStartPreference,
  serializeReviewStartPreference,
} from "./reviewStartPreference";

describe("review start preference", () => {
  it("opens on Quick and Auto the first time, and on the last choices after", () => {
    expect(parseReviewStartPreference(null)).toEqual({ mode: "quick", scope: null });
    const saved = serializeReviewStartPreference({
      mode: "deep",
      scope: { kind: "branch", base: "origin/main" },
    });
    expect(parseReviewStartPreference(saved)).toEqual({
      mode: "deep",
      scope: { kind: "branch", base: "origin/main" },
    });
  });

  it("does not remember a commit, and ignores what it cannot read", () => {
    expect(
      parseReviewStartPreference(
        serializeReviewStartPreference({
          mode: "security",
          scope: { kind: "commit", sha: "abc1234" },
        }),
      ),
    ).toEqual({ mode: "security", scope: null });
    expect(parseReviewStartPreference("{not json")).toEqual({ mode: "quick", scope: null });
    expect(parseReviewStartPreference('{"mode":"thorough","scope":{"kind":"everything"}}')).toEqual(
      {
        mode: "quick",
        scope: null,
      },
    );
  });
});
