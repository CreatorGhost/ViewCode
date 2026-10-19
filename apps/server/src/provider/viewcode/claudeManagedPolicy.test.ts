import { describe, expect, it } from "vite-plus/test";
import type { ClaudeAgentSdkQueryOptions } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import {
  claudeEnterpriseMcpRefusal,
  claudeManagedQueryOptions,
  claudeManagedRuntimePolicy,
  CLAUDE_MANAGED_MCP_NOTICE,
} from "./claudeManagedPolicy.ts";

const options: ClaudeAgentSdkQueryOptions = {
  model: "sonnet",
  sessionId: "native-session",
  tools: { type: "preset", preset: "claude_code" },
  permissionMode: "bypassPermissions",
  allowDangerouslySkipPermissions: true,
  mcpServers: {
    "t3-code": {
      type: "http",
      url: "http://localhost/mcp",
      headers: { Authorization: "Bearer credential" },
    },
  },
  allowedTools: ["Read", "mcp__t3-code__*"],
  extraArgs: {
    "permission-mode": "bypassPermissions",
    "dangerously-skip-permissions": null,
    "allow-dangerously-skip-permissions": null,
    verbose: null,
  },
  systemPrompt: { type: "preset", preset: "claude_code", append: "Original instructions" },
};

describe("Claude managed policy", () => {
  it("omits ViewCode MCP configuration under enterprise management and tells the agent", () => {
    const restricted = claudeManagedQueryOptions(options, {
      mcpManaged: true,
      bypassDisabled: false,
    });
    expect(restricted.mcpServers).toBeUndefined();
    expect(restricted.allowedTools).toEqual(["Read"]);
    expect(
      typeof restricted.systemPrompt === "object" &&
        !Array.isArray(restricted.systemPrompt) &&
        restricted.systemPrompt?.type === "preset" &&
        restricted.systemPrompt.append,
    ).toContain(CLAUDE_MANAGED_MCP_NOTICE);
    expect(options.mcpServers).toBeDefined();
  });

  it("applies the admin permission mode to the runtime and strips launch overrides", () => {
    const policy = claudeManagedRuntimePolicy(
      {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: null,
        approvalPolicy: "never",
      },
      true,
    );
    expect(policy.runtimeMode).toBe("auto-accept-edits");
    expect(policy.approvalPolicy).toBe("on-request");
    const restricted = claudeManagedQueryOptions(options, {
      mcpManaged: false,
      bypassDisabled: true,
    });
    expect(restricted.permissionMode).toBe("acceptEdits");
    expect(restricted.allowDangerouslySkipPermissions).toBeUndefined();
    expect(restricted.extraArgs).toEqual({ verbose: null });
    expect(restricted.mcpServers).toBeDefined();
  });

  it("recognizes the specific enterprise refusal through a wrapped cause", () => {
    const refusal = new Error(
      "You cannot dynamically configure MCP servers when an enterprise MCP config is present",
    );
    expect(claudeEnterpriseMcpRefusal(new Error("startup", { cause: refusal }))).toBe(true);
    expect(claudeEnterpriseMcpRefusal(new Error("permission denied"))).toBe(false);
    const cyclic: { cause?: unknown } = {};
    cyclic.cause = cyclic;
    expect(claudeEnterpriseMcpRefusal(cyclic)).toBe(false);
  });
});
