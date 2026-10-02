import { describe, expect, it } from "vite-plus/test";

import { isClaudeEnterpriseMcpRefusal } from "./Drivers/ClaudeEnterprisePolicy.ts";
import {
  PROVIDER_STDERR_EXCERPT_MAX_CHARS,
  findClaudeProcessExit,
  formatProviderProcessExit,
  isClaudeQueryGone,
} from "./providerProcessExit.ts";

const ENTERPRISE_STDERR =
  "You cannot dynamically configure MCP servers when an enterprise MCP config is present";

describe("findClaudeProcessExit", () => {
  it("reads the exit code and stderr from anywhere in the cause chain", () => {
    const sdkError = new Error(
      `Claude Code process exited with code 1. stderr: ${ENTERPRISE_STDERR}`,
    );
    const wrapped = { message: "Provider adapter process error", cause: sdkError };
    expect(findClaudeProcessExit(wrapped)).toEqual({ code: 1, stderr: ENTERPRISE_STDERR });
  });

  it("reads a signal and a wrapped write failure", () => {
    expect(
      findClaudeProcessExit(
        new Error(
          "Cannot write to process that exited with error: Claude Code process terminated by signal SIGKILL",
        ),
      ),
    ).toEqual({ signal: "SIGKILL" });
  });

  it("ignores errors that are not a Claude process exit", () => {
    expect(findClaudeProcessExit(new Error("credential material"))).toBeUndefined();
  });
});

describe("formatProviderProcessExit", () => {
  it("attributes the failure to the provider process with its stderr", () => {
    expect(
      formatProviderProcessExit("Claude Code", { code: 1, stderr: ` ${ENTERPRISE_STDERR}\n` }),
    ).toBe(`Claude Code exited (code 1): ${ENTERPRISE_STDERR}`);
    expect(formatProviderProcessExit("Claude Code", { code: 2 })).toBe(
      "Claude Code exited (code 2).",
    );
  });

  it("keeps the last ~2KB and redacts secrets", () => {
    const stderr = `${"x".repeat(5_000)}\nAuthorization: Bearer abc.def-123 sk-ant-api03-secretsecret`;
    const message = formatProviderProcessExit(
      "Claude Code",
      { code: 1, stderr },
      { HOME: "/nohome" },
    );
    expect(message.length).toBeLessThan(PROVIDER_STDERR_EXCERPT_MAX_CHARS + 50);
    expect(message).toContain("Bearer [redacted]");
    expect(message).not.toContain("abc.def-123");
    expect(message).not.toContain("sk-ant-api03-secretsecret");
  });
});

describe("Claude CLI failure classification", () => {
  it("recognises only Claude Code's enterprise MCP refusal", () => {
    expect(isClaudeEnterpriseMcpRefusal(ENTERPRISE_STDERR)).toBe(true);
    expect(
      isClaudeEnterpriseMcpRefusal(
        "You cannot use --strict-mcp-config when an enterprise MCP config is present",
      ),
    ).toBe(true);
    expect(isClaudeEnterpriseMcpRefusal("MCP server viewcode failed to connect")).toBe(false);
  });

  it("treats closed queries and exits as a gone CLI, other failures not", () => {
    expect(isClaudeQueryGone(new Error("Query closed before response received"))).toBe(true);
    expect(isClaudeQueryGone(new Error("Claude Code process exited with code 1"))).toBe(true);
    expect(isClaudeQueryGone(new Error("Invalid permission mode"))).toBe(false);
  });
});
