import { describe, expect, it } from "vite-plus/test";

import { classifyProviderFailure, describeProviderFailure } from "./providerFailure.ts";

describe("classifyProviderFailure", () => {
  it.each([
    ["Error: RetriableError: [invalid_argument] Invalid request", "validation_error", true],
    ["Error: ConnectError: [permission_denied] subscription required", "permission_error", false],
    ["Error: ConnectError: [unauthenticated] sign in", "permission_error", false],
    ["Error: ConnectError: [unavailable] transport closed", "transport_error", true],
    ["Error: ConnectError: [deadline_exceeded] timed out", "transport_error", true],
    ["Error: RetriableError: WritableIterable is closed", "transport_error", true],
    [
      "Something went wrong communicating with the server. Please try again.",
      "transport_error",
      true,
    ],
    ["Error: RetriableError: [internal] Failed to run step", "provider_error", true],
    ["You've hit your usage limit. Resets at 3pm.", "usage_limit", false],
    ["429 Too Many Requests: rate limit exceeded", "provider_error", true],
    ["Request entity too large (413)", "validation_error", false],
    ["The model gpt-5.5 is not enabled for your team.", "permission_error", false],
    ["This model is not available for your organization", "permission_error", false],
    ["Your organization does not have access to the model claude-opus", "permission_error", false],
    ["Something unexpected", "unknown", false],
  ] as const)("%s → %s", (message, expectedClass, retryable) => {
    const failure = classifyProviderFailure(message);
    expect(failure.class).toBe(expectedClass);
    expect(failure.retryable).toBe(retryable);
    expect(failure.message).toBe(message);
  });

  it("keeps the bracketed code", () => {
    expect(classifyProviderFailure("Error: RetriableError: [invalid_argument] x").code).toBe(
      "invalid_argument",
    );
    expect(classifyProviderFailure("plain text").code).toBeNull();
  });

  it("does not treat an unrelated setting that is not enabled as an entitlement", () => {
    expect(classifyProviderFailure("Telemetry is not enabled for this run").class).toBe("unknown");
  });
});

describe("describeProviderFailure", () => {
  it("names the model for an entitlement rejection instead of blaming the connection", () => {
    const text = describeProviderFailure(
      classifyProviderFailure("Error: ConnectError: [permission_denied] model not allowed"),
      { provider: "Cursor", model: "gpt-5.5" },
    );
    expect(text).toContain('the model "gpt-5.5"');
    expect(text).not.toMatch(/connection|transport/i);
  });

  it("names the payload as a likely cause of an invalid request", () => {
    expect(
      describeProviderFailure(classifyProviderFailure("RetriableError: [invalid_argument] x"), {
        provider: "Cursor",
      }),
    ).toMatch(/images are resent on every turn/);
  });
});
