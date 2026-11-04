import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { mapRemoteEnvironmentError } from "./errors.ts";

// ViewCode guard (861f4a814): a refused pairing code says why, when the server can name it.
const reject = (pairingProblem?: "expired" | "used") =>
  mapRemoteEnvironmentError(
    new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      ...(pairingProblem ? { pairingProblem } : {}),
      traceId: "trace-1",
    }),
  );

describe("pairing code rejections (ViewCode)", () => {
  it("says an expired pairing code has expired", () => {
    expect(reject("expired")).toMatchObject({ detail: expect.stringContaining("has expired") });
  });

  it("says a used pairing code was already used", () => {
    expect(reject("used")).toMatchObject({ detail: expect.stringContaining("already used") });
  });

  it("keeps the generic message when the server names no reason", () => {
    expect(reject()).toMatchObject({ detail: "The environment credential is invalid." });
  });
});
