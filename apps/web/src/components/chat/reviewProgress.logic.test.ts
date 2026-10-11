import { describe, expect, it } from "vite-plus/test";

import { formatReviewElapsed, shortReviewError } from "./reviewProgress.logic";

describe("formatReviewElapsed", () => {
  it("counts whole minutes, then hours and minutes", () => {
    expect(formatReviewElapsed(30_000)).toBe("just started");
    expect(formatReviewElapsed(6 * 60_000 + 59_000)).toBe("6 min");
    expect(formatReviewElapsed(65 * 60_000)).toBe("1 h 5 min");
    expect(formatReviewElapsed(120 * 60_000)).toBe("2 h");
    // A clock a little behind the server's start never shows a negative time.
    expect(formatReviewElapsed(-5_000)).toBe("just started");
  });
});

describe("shortReviewError", () => {
  it("keeps the first line of the provider's error, cut to one status line", () => {
    expect(shortReviewError("\nQuota exceeded\n    at stack frame")).toBe("Quota exceeded");
    expect(shortReviewError("x".repeat(200))).toHaveLength(140);
    expect(shortReviewError(null)).toBe("the reviewer stopped with an error");
  });
});
