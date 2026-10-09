import * as Cause from "effect/Cause";
import { describe, expect, it } from "vite-plus/test";

import { formatEnvironmentQueryError } from "./query";

describe("formatEnvironmentQueryError", () => {
  it("reports nothing for a read that was only cancelled", () => {
    expect(formatEnvironmentQueryError(Cause.interrupt())).toBeNull();
    expect(
      formatEnvironmentQueryError(Cause.combine(Cause.interrupt(1), Cause.interrupt(2))),
    ).toBeNull();
  });

  it("reports the failure's own message, even alongside an interrupt", () => {
    const failure = Cause.fail(new Error("gh is not signed in"));
    expect(formatEnvironmentQueryError(failure)).toBe("gh is not signed in");
    expect(formatEnvironmentQueryError(Cause.combine(Cause.interrupt(), failure))).toBe(
      "gh is not signed in",
    );
  });

  it("falls back to a generic message when the failure has none", () => {
    expect(formatEnvironmentQueryError(Cause.fail("opaque"))).toBe(
      "The environment request failed.",
    );
  });
});
