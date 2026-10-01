const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the viewcode MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

// ViewCode agents are full, visible chats the user can open, prompt and switch
// models on. Every toolkit tool carries the viewcode_ prefix (as Traycer prefixes
// traycer_*) so it can't be confused with a harness's own tools, such as
// Codex's built-in spawn_agent. Provider-native sub-agents stay available.
const viewcodeAgentsInstructions = (allowNativeAgentFallback: boolean) => `<viewcode_agents>
ViewCode agents are separate agents the user sees in the ViewCode sidebar: each has its own chat, provider and model, the user can open and prompt it, and its final answer is sent back to you automatically. When the viewcode MCP server exposes viewcode_spawn_agent and the user asks for sub-agents, child agents, agents, helpers or parallel agents, create ViewCode agents: call viewcode_list_models if you need provider or model ids, then viewcode_spawn_agent once per agent with the provider and model the user named, then viewcode_send_message for follow-ups. If an agent was out of usage and its reset time has passed, just send the message: viewcode_list_agents shows outOfUsage while a limit holds, and messages sent meanwhile are queued and delivered automatically when it resets. To set an agent's thinking level ("set to High" means effort "high") or fast mode, pass effort/fast_mode to viewcode_spawn_agent or viewcode_configure_agent; never ask the user to set it in the picker. Your harness's built-in sub-agents (for example a native spawn_agent or Task tool) are a different feature: ${
  allowNativeAgentFallback
    ? "use them when the user explicitly asks for built-in, inline or in-chat sub-agents, or as a fallback when viewcode_spawn_agent is unavailable or fails. Explain the failure and that you are using native tasks, then proceed without an extra confirmation. Native tasks appear inside the current chat; they are not separate ViewCode chats with an independent model picker. If the user requires a particular provider/model or a separate child chat that native tasks cannot provide, report that limitation instead of silently substituting."
    : "use them only when the user explicitly asks for built-in, inline or in-chat sub-agents, and say which kind you used. If viewcode_spawn_agent is unavailable or fails, do not fall back on your own: tell the user what failed and ask whether to use your built-in sub-agents instead."
}
If the viewcode_* tools are missing from your tool list, say so plainly to the user instead of working around it silently. Name the likely causes (for example, the provider's MCP policy: "Cursor team policy may block MCP servers") and offer to continue with child agents the user creates from the ViewCode sidebar.
</viewcode_agents>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(runtime: {
  readonly harness: string;
  readonly model?: string | undefined;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
  readonly allowNativeAgentFallback?: boolean;
  /**
   * Set when the session runs without ViewCode's MCP server, so the prompt
   * never advertises tools the session does not have.
   */
  readonly viewcodeToolsUnavailable?: "managed-mcp" | "setting" | undefined;
}): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in ViewCode through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`;
  if (runtime.viewcodeToolsUnavailable) {
    return `${runtimeInfo}\n\n${viewcodeToolsUnavailableInstructions(runtime.viewcodeToolsUnavailable)}`;
  }
  return `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${viewcodeAgentsInstructions(runtime.allowNativeAgentFallback ?? false)}`;
}

const viewcodeToolsUnavailableInstructions = (reason: "managed-mcp" | "setting") =>
  `<viewcode_tools>
ViewCode's own tools (the viewcode MCP server: browser preview, devices, pull request linking and ViewCode agents such as viewcode_spawn_agent) are not available in this session, because ${
    reason === "managed-mcp"
      ? "the user's organization manages this harness's MCP servers"
      : "the user turned them off in ViewCode's settings"
  }. Do not claim to use them. If the user asks for something that needs them, say so plainly and continue with your built-in tools; the user can still create child agents from the ViewCode sidebar.
</viewcode_tools>`;

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
