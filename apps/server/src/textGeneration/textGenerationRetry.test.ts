import { TextGenerationError } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isRetryableTextGenerationError } from "./textGenerationRetry.ts";

const error = (detail: string) =>
  new TextGenerationError({ operation: "generateThreadTitle", detail });

describe("isRetryableTextGenerationError", () => {
  it("does not retry a killed or refused launch", () => {
    expect(isRetryableTextGenerationError(error("Claude CLI command failed with code 137."))).toBe(
      false,
    );
    expect(
      isRetryableTextGenerationError(
        error("Provider instance 'codex' is disabled in ViewCode settings."),
      ),
    ).toBe(false);
    expect(
      isRetryableTextGenerationError(
        error(
          "The executable for provider instance 'codex' was not found, so it was not launched.",
        ),
      ),
    ).toBe(false);
  });

  it("retries ordinary failures", () => {
    expect(isRetryableTextGenerationError(error("Claude CLI request timed out."))).toBe(true);
    expect(isRetryableTextGenerationError(error("Claude CLI command failed: overloaded"))).toBe(
      true,
    );
  });
});
