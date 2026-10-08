import type { ComputerUseGrant } from "../mcp/McpProviderSession.ts";
import { shellCommandWord } from "../computerUse/ComputerUseCli.ts";

const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the viewcode MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked.
</pull_request_linking>`;

const PULL_REQUEST_WATCH_INSTRUCTIONS = `<pull_request_watch>
When asked to monitor, watch, or babysit a pull request and the viewcode MCP server exposes watch_pull_request, call it and end your turn. ViewCode wakes you with a message when checks fail or pass, someone else comments or reviews, or the branch conflicts, so do not poll, sleep, or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first.
</pull_request_watch>`;

// ViewCode agents are full, visible chats the user can open, prompt and switch
// models on. Every toolkit tool carries the viewcode_ prefix (as Traycer prefixes
// traycer_*) so it can't be confused with a harness's own tools, such as
// Codex's built-in spawn_agent. Visible agents are the default; the harness's
// own sub-agents are the announced fallback, on every provider.
const VIEWCODE_AGENTS_INSTRUCTIONS = `<viewcode_agents>
ViewCode agents are separate agents the user sees in the ViewCode sidebar: each has its own chat, provider and model, the user can open and prompt it, and its final answer is sent back to you automatically. When the user asks for sub-agents, child agents, agents, helpers or parallel agents, create ViewCode agents by default: call viewcode_list_models if you need provider or model ids, then viewcode_spawn_agent once per agent with the provider and model the user named and a short task (3 to 8 words saying what it will do), then viewcode_send_message for follow-ups. If an agent was out of usage and its reset time has passed, just send the message: viewcode_list_agents shows outOfUsage while a limit holds, and messages sent meanwhile are queued and delivered automatically when it resets. To set an agent's thinking level ("set to High" means effort "high") or fast mode, pass effort/fast_mode to viewcode_spawn_agent or viewcode_configure_agent; never ask the user to set it in the picker.
Your harness's built-in sub-agents (for example a native spawn_agent or Task tool) run inline in this chat; they are not separate ViewCode chats and have no model picker of their own. Use them:
- when the user asks for built-in, inline or in-chat sub-agents;
- as the fallback when viewcode_spawn_agent is missing from your tools or fails: say in one sentence what failed and that you are using inline sub-agents instead, then proceed without asking;
- on your own initiative, when the user did not ask for agents and you want a quick, self-contained lookup (searching or reading code) that does not deserve its own chat.
If the user requires a particular provider or model, or a separate chat, that inline sub-agents cannot provide, say so instead of silently substituting. If the viewcode_* tools are missing from your tool list, name the likely cause (for example, the provider's MCP policy: "Cursor team policy may block MCP servers") and mention that the user can also create child agents from the ViewCode sidebar.
</viewcode_agents>`;

/**
 * Mermaid renders in the client and needs no MCP, so every session gets this.
 * Codex sends it as its own `additionalContext` entry, keyed by the tag, to keep
 * the runtime entry under Codex's per-entry token cap.
 */
export const VIEWCODE_DIAGRAMS_GUIDANCE = `A \`\`\`mermaid block in your reply renders inline as a diagram the reader can expand, zoom and pan. Use one unasked when a flowchart, architecture, sequence, state, class, ER, gantt, pie, git graph, mindmap or timeline diagram explains better than prose. The reader already sees it, so don't point to mermaid.live or another viewer, say where to view it, or restate it in prose, and don't build HTML pages, servers or screenshots to show one. Don't set colours (style, classDef, init themes); ViewCode themes diagrams.`;

const VIEWCODE_DIAGRAMS_INSTRUCTIONS = `<viewcode_diagrams>\n${VIEWCODE_DIAGRAMS_GUIDANCE}\n</viewcode_diagrams>`;

export const VIEWCODE_VISUALS_INSTRUCTIONS = `<viewcode_visuals>
For a data chart, mockup, image collage or layout Mermaid can't draw, and only when the viewcode MCP server exposes html_render, build a self-contained HTML page and publish it with html_render before your final reply. The reader sees the page above that reply, so don't announce or restate it; add only what it doesn't say.
</viewcode_visuals>`;

/**
 * Computer use goes through a CLI, not MCP, so it is offered even when the
 * session runs without ViewCode's MCP server. `viewcode-computer help` is the
 * manual; this block names the exact launcher path (the only form providers'
 * prompts are auto-approved in), the focus rule and rules out the workarounds.
 */
export function computerUseGuidance(grant: ComputerUseGrant): string {
  const cli = shellCommandWord(grant.cli);
  const scope =
    grant.mode === "observe"
      ? "This session may only observe (list windows, read their elements, take screenshots); input actions are unavailable."
      : "Input actions only work while your turn is running and may wait for the user to approve them. Refs (press, set-value, type --ref) act in the background without taking the user's focus: prefer them. By default, key, scroll, coordinate input and type --window bring the window to the front and take focus. Experimental background environments may refuse unsupported input instead: follow the help manual, inspect tookFocus and verify the intended result. Never retry a refusal by taking focus unless Show on screen permits it.";
  return `You can see and operate apps on the user's computer with the viewcode-computer CLI, run through your shell tool. Always invoke it by this absolute path, exactly as written: ${cli}. Run \`${cli} help\` before first use; its output is the manual. ${scope}
Use viewcode-computer for all desktop observation and control; do not use other installed desktop or browser automation tools, skills or scripts (osascript, screencapture, cliclick, python screen tools, Playwright/Chromium skills) instead, even if available. If viewcode-computer refuses an action, tell the user what was refused and why instead of working around it.`;
}

export function computerUseInstructions(grant: ComputerUseGrant): string {
  return `<viewcode_computer_use>\n${computerUseGuidance(grant)}\n</viewcode_computer_use>`;
}

/**
 * The collaborative browser also goes through a CLI, so sessions without
 * ViewCode's MCP server (managed MCP, or the tools turned off) can still use
 * it. With MCP, the preview_* tools drive the same browser and tab.
 */
export const BROWSER_CLI_GUIDANCE = `ViewCode's collaborative browser, which the user sees in their ViewCode window, is also available from your shell as the viewcode-browser command. Run \`viewcode-browser help\` before first use; its output is the manual. When the viewcode MCP preview_* tools are in your tool list, prefer them: they drive the same browser and tab. Otherwise use viewcode-browser to open, inspect and test web pages and local dev servers instead of standalone Playwright, agent-browser or a headless Chrome, unless it reports that no browser is available or the user asks for a different browser.`;

export const BROWSER_CLI_INSTRUCTIONS = `<viewcode_browser>\n${BROWSER_CLI_GUIDANCE}\n</viewcode_browser>`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `modelName` is the display name users see in the model picker; `model` is the slug.
 */
export function buildRuntimeInstructions(
  runtime: {
    readonly harness: string;
    readonly model?: string | undefined;
    readonly modelName?: string | undefined;
    readonly reasoningEffort?: string | undefined;
    /**
     * Set when the session runs without ViewCode's MCP server, so the prompt
     * never advertises tools the session does not have.
     */
    readonly viewcodeToolsUnavailable?: "managed-mcp" | "setting" | undefined;
    /** Set when the session was granted computer use (its CLI is on PATH). */
    readonly computerUse?: ComputerUseGrant | undefined;
    /** Set when the session may use the collaborative browser and its CLI is on PATH. */
    readonly browserCli?: boolean | undefined;
    /** False when the caller sends `VIEWCODE_DIAGRAMS_GUIDANCE` on its own. */
    readonly diagrams?: boolean | undefined;
  },
  options: { readonly separateCliEntries?: boolean } = {},
): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const runtimeInfo = `<runtime_info>In case you're asked: you are running in ViewCode through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>`;
  const computerUse =
    !options.separateCliEntries && runtime.computerUse
      ? `\n\n${computerUseInstructions(runtime.computerUse)}`
      : "";
  const browser =
    !options.separateCliEntries && runtime.browserCli ? `\n\n${BROWSER_CLI_INSTRUCTIONS}` : "";
  const diagrams = runtime.diagrams === false ? "" : `\n\n${VIEWCODE_DIAGRAMS_INSTRUCTIONS}`;
  if (runtime.viewcodeToolsUnavailable) {
    return `${runtimeInfo}\n\n${viewcodeToolsUnavailableInstructions(runtime.viewcodeToolsUnavailable, runtime.browserCli === true)}${diagrams}${browser}${computerUse}`;
  }
  return `${runtimeInfo}\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}\n\n${PULL_REQUEST_WATCH_INSTRUCTIONS}\n\n${VIEWCODE_AGENTS_INSTRUCTIONS}${diagrams}\n\n${VIEWCODE_VISUALS_INSTRUCTIONS}${browser}${computerUse}`;
}

const viewcodeToolsUnavailableInstructions = (
  reason: "managed-mcp" | "setting",
  browserCli: boolean,
) =>
  `<viewcode_tools>
ViewCode's own tools (the viewcode MCP server: ${browserCli ? "" : "browser preview, "}devices, pull request linking, inline HTML pages and ViewCode agents such as viewcode_spawn_agent) are not available in this session, because ${
    reason === "managed-mcp"
      ? "the user's organization manages this harness's MCP servers"
      : "the user turned them off in ViewCode's settings"
  }. Do not claim to use them. If the user asks for something that needs them, say so plainly and continue with your built-in tools. When the user asks for agents, use your harness's built-in sub-agents and say they run inline in this chat; the user can still create visible child agents from the ViewCode sidebar.
</viewcode_tools>`;

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
