import { EnvironmentAuthInvalidError } from "@t3tools/contracts";
import { describe, expect, it } from "vitest";

import { PrimaryEnvironmentPairingCredentialRejectedError } from "./auth.ts";

// ViewCode guard (8eb20b982): the pairing screen names a used or expired code instead of
// calling it an invalid token.
const rejected = (pairingProblem?: "expired" | "used") =>
  new PrimaryEnvironmentPairingCredentialRejectedError({
    providedLength: 12,
    cause: new EnvironmentAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_credential",
      ...(pairingProblem ? { pairingProblem } : {}),
      traceId: "trace-1",
    }),
  });

describe("PrimaryEnvironmentPairingCredentialRejectedError (ViewCode)", () => {
  it("says a used pairing code was already used", () => {
    expect(rejected("used").message).toBe(
      "This pairing code was already used. Make a new one and try again.",
    );
  });

  it("says an expired pairing code has expired", () => {
    expect(rejected("expired").message).toContain("has expired");
  });

  it("keeps the invalid-token message when no reason is named", () => {
    expect(rejected().message).toBe("Invalid pairing token. Check the token and try again.");
  });
});
