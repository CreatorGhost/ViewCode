const PULL_REQUEST_LINKING_INSTRUCTIONS = `<pull_request_linking>
When the t3-code MCP server exposes link_pull_request, you must use it to register every pull request you create or work on for this thread. Call link_pull_request with the full PR URL immediately after creating a PR or starting work on an existing PR. For a stack, call it for every layer, not just the current branch or the top PR. This applies when creating or updating PRs through gh, gh stack, another CLI, or the host API: those operations do not register the PRs with this thread. Linking an already-linked PR is safe. Before finishing PR work, call list_thread_pull_requests and link any PR from your work that is missing. Do not link unrelated PRs mentioned only as background. If a linking call fails, report that failure instead of claiming the PR is linked. When asked to monitor, watch, or babysit a PR and watch_pull_request is available, call it and end your turn: ViewCode wakes you when checks finish, someone else comments, or the branch conflicts, so do not poll or run your own watcher. When you hand the work back to the user, call unwatch_pull_request first so the thread returns to their inbox.
</pull_request_linking>`;

/**
 * Mermaid renders in the client and needs no MCP, so every session gets this. Codex sends it as
 * its own `additionalContext` entry to keep each entry under Codex's per-entry cap.
 */
export const VIEWCODE_DIAGRAMS_GUIDANCE = `A \`\`\`mermaid block in your reply renders inline as a diagram the reader can expand, zoom and pan. Use one unasked when a flowchart, architecture, sequence, state, class, ER, gantt, pie, git graph, mindmap or timeline diagram explains better than prose. The reader already sees it, so don't point to mermaid.live or another viewer, say where to view it, or restate it in prose, and don't build HTML pages, servers or screenshots to show one. Don't set colours (style, classDef, init themes); ViewCode themes diagrams.`;

/**
 * The client gives a quoted draft a copy button that converts it for Slack, WhatsApp, email and
 * so on, so drafts need to arrive as a bare quote. Like the diagrams guidance it needs no MCP.
 */
export const VIEWCODE_DRAFTS_GUIDANCE = `When you draft a message for the user to send elsewhere (Slack, email, WhatsApp, a PR comment…), put only the message itself in a \`>\` quote block in plain Markdown, with no commentary inside it; ViewCode gives the quote a copy button that converts it for the destination.`;

/**
 * The collaborative browser also goes through a CLI, so a session without ViewCode's MCP server
 * (managed MCP, the tools turned off, or a provider with no MCP) can still use it. Only for a
 * session whose environment has the CLI (`browserCliAvailable`).
 */
export const BROWSER_CLI_GUIDANCE = `ViewCode's collaborative browser, which the user sees in their ViewCode window, is also available from your shell as the viewcode-browser command. Run \`viewcode-browser help\` before first use; its output is the manual. When the t3-code MCP server's preview_* tools are in your tool list, prefer them: they drive the same browser and tab. Either way, open, inspect and test web pages and local dev servers in this browser, which the user can watch. Do not launch Playwright (with any engine, including its Firefox), Puppeteer, agent-browser, a headless Chrome or another browser window unless viewcode-browser reports that no browser is available, the user asks for a different browser, or you are running the project's own end-to-end tests.`;

/**
 * Shared runtime context; omit model and effort when the harness manages them dynamically.
 * `separateEntries` leaves out the diagrams, drafts and browser blocks, for a caller that sends
 * each as its own entry (Codex).
 */
export function buildRuntimeInstructions(
  runtime: {
    readonly harness: string;
    readonly model?: string | undefined;
    readonly modelName?: string | undefined;
    readonly reasoningEffort?: string | undefined;
    /** The session's environment has the `viewcode-browser` CLI. */
    readonly browserCli?: boolean | undefined;
  },
  options: { readonly separateEntries?: boolean } = {},
): string {
  const harness = toSingleLine(runtime.harness);
  const model = toSingleLine(runtime.model ?? "");
  const modelName = toSingleLine(runtime.modelName ?? "");
  const effort = toSingleLine(runtime.reasoningEffort ?? "");
  const modelLabel =
    modelName && modelName !== model ? `${modelName} (model slug: ${model})` : model;
  const modelInfo = model && model !== "auto" && model !== "default" ? `, as ${modelLabel}` : "";
  const effortInfo = effort ? ` with ${effort} reasoning effort` : "";
  const base = `<runtime_info>In case you're asked: you are running in ViewCode through the ${harness} harness${modelInfo}${effortInfo}. No need to mention this otherwise. You can embed images and videos in your response using Markdown with absolute file paths.</runtime_info>\n\n${PULL_REQUEST_LINKING_INSTRUCTIONS}`;
  if (options.separateEntries === true) return base;
  return [
    base,
    `<viewcode_diagrams>\n${VIEWCODE_DIAGRAMS_GUIDANCE}\n</viewcode_diagrams>`,
    `<viewcode_drafts>\n${VIEWCODE_DRAFTS_GUIDANCE}\n</viewcode_drafts>`,
    ...(runtime.browserCli === true
      ? [`<viewcode_browser>\n${BROWSER_CLI_GUIDANCE}\n</viewcode_browser>`]
      : []),
  ].join("\n\n");
}

function toSingleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}
