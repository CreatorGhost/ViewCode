import type { ClaudeAgentSdkQueryOptions } from "../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import type { ProviderAdapterV2RuntimePolicy } from "@t3tools/provider-core/server/ProviderAdapter";

export const CLAUDE_MANAGED_MCP_NOTICE =
  "Your organization manages Claude Code MCP servers. ViewCode tools are unavailable in this session. Do not claim to call them.";

export function claudeEnterpriseMcpRefusal(cause: unknown): boolean {
  const seen = new Set<unknown>();
  for (let depth = 0; depth < 8 && cause != null && !seen.has(cause); depth++) {
    seen.add(cause);
    const message =
      typeof cause === "string"
        ? cause
        : typeof cause === "object" && "message" in cause
          ? cause.message
          : undefined;
    if (
      typeof message === "string" &&
      /cannot (?:dynamically configure MCP servers|use --strict-mcp-config) when an enterprise MCP config is present/i.test(
        message,
      )
    )
      return true;
    cause = typeof cause === "object" && "cause" in cause ? cause.cause : undefined;
  }
  return false;
}

export function claudeManagedRuntimePolicy(
  policy: ProviderAdapterV2RuntimePolicy,
  bypassDisabled: boolean,
): ProviderAdapterV2RuntimePolicy {
  if (!bypassDisabled) return policy;
  // An explicit wire-level approval override cannot weaken the administrator's setting.
  return {
    ...policy,
    runtimeMode: policy.runtimeMode === "full-access" ? "auto-accept-edits" : policy.runtimeMode,
    ...(policy.approvalPolicy === "never" ? { approvalPolicy: "on-request" } : {}),
  };
}

export function claudeManagedQueryOptions(
  options: ClaudeAgentSdkQueryOptions,
  policy: { readonly mcpManaged: boolean; readonly bypassDisabled: boolean },
): ClaudeAgentSdkQueryOptions {
  let result = options;
  if (policy.mcpManaged) {
    const { mcpServers: _mcpServers, allowedTools, ...rest } = result;
    const prompt = rest.systemPrompt;
    result = {
      ...rest,
      ...(allowedTools
        ? { allowedTools: allowedTools.filter((tool) => !tool.startsWith("mcp__t3-code__")) }
        : {}),
      systemPrompt:
        typeof prompt === "string"
          ? `${prompt}\n\n${CLAUDE_MANAGED_MCP_NOTICE}`
          : Array.isArray(prompt)
            ? [...prompt, CLAUDE_MANAGED_MCP_NOTICE]
            : prompt?.type === "preset"
              ? { ...prompt, append: `${prompt.append ?? ""}\n\n${CLAUDE_MANAGED_MCP_NOTICE}` }
              : prompt?.type === "custom"
                ? {
                    ...prompt,
                    prompt:
                      typeof prompt.prompt === "string"
                        ? `${prompt.prompt}\n\n${CLAUDE_MANAGED_MCP_NOTICE}`
                        : [...prompt.prompt, CLAUDE_MANAGED_MCP_NOTICE],
                  }
                : CLAUDE_MANAGED_MCP_NOTICE,
    };
  }
  if (policy.bypassDisabled) {
    const { allowDangerouslySkipPermissions: _allowBypass, ...rest } = result;
    const extraArgs = { ...rest.extraArgs };
    delete extraArgs["dangerously-skip-permissions"];
    delete extraArgs["allow-dangerously-skip-permissions"];
    if (extraArgs["permission-mode"] === "bypassPermissions") delete extraArgs["permission-mode"];
    result = {
      ...rest,
      extraArgs,
      ...(rest.permissionMode === "bypassPermissions" ? { permissionMode: "acceptEdits" } : {}),
    };
  }
  return result;
}
