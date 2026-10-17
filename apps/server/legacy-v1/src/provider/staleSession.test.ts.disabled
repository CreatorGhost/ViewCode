import { assert, describe, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import { ThreadId } from "@t3tools/contracts";

import { ProviderAdapterRequestError, ProviderAdapterSessionNotFoundError } from "./Errors.ts";
import { isStaleProviderSessionCause } from "./staleSession.ts";

describe("isStaleProviderSessionCause", () => {
  it("finds the Claude CLI refusal inside a wrapped control request failure", () => {
    const error = new ProviderAdapterRequestError({
      provider: "claudeAgent",
      method: "turn/setPermissionMode",
      detail: "turn/setPermissionMode failed",
      cause: new Error(
        "Claude Code process exited with code 1. stderr: No conversation found with session ID: ec8ee806-2e9a-4450-a253-a23527795b27",
      ),
    });
    assert.isTrue(isStaleProviderSessionCause(Cause.fail(error)));
    assert.isTrue(
      isStaleProviderSessionCause(
        Cause.fail(
          new Error(
            "Claude Code returned an error result: No message found with message.uuid of: 0b6c",
          ),
        ),
      ),
    );
  });

  it("does not treat a missing live adapter session or other failures as stale", () => {
    assert.isFalse(
      isStaleProviderSessionCause(
        Cause.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: "claudeAgent",
            threadId: ThreadId.make("thread-1"),
          }),
        ),
      ),
    );
    assert.isFalse(
      isStaleProviderSessionCause(
        Cause.fail(
          new ProviderAdapterRequestError({
            provider: "claudeAgent",
            method: "turn/setPermissionMode",
            detail: "turn/setPermissionMode failed",
            cause: new Error("Claude Code process exited with code 1. stderr: Invalid API key"),
          }),
        ),
      ),
    );
  });
});
