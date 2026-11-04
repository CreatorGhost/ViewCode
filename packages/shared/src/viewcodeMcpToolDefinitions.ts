import type { T3McpToolDefinition } from "./t3McpToolPresentation.ts";

export type ViewCodeMcpToolSummaryAction =
  | "review-start"
  | "review-submit"
  | "review-post"
  | "agent-list"
  | "model-list"
  | "goal-read"
  | "goal-update"
  | "debug-read"
  | "debug-update";

function tool(
  labels: T3McpToolDefinition["labels"],
  summaryAction: T3McpToolDefinition["summaryAction"],
  icon: T3McpToolDefinition["icon"] = "t3-code",
): T3McpToolDefinition {
  return { displayName: `${labels[0]} ${labels[3]}`, labels, summaryAction, icon };
}

export const VIEWCODE_MCP_TOOL_DEFINITIONS: Readonly<Record<string, T3McpToolDefinition>> = {
  review_pull_request: tool(
    ["Start", "Starting", "Started", "a pull request review"],
    "review-start",
    "pull-request",
  ),
  review_local_changes: tool(
    ["Start", "Starting", "Started", "a local changes review"],
    "review-start",
    "pull-request",
  ),
  submit_review_findings: tool(
    ["Record", "Recording", "Recorded", "review findings"],
    "review-submit",
    "pull-request",
  ),
  post_review_findings: tool(
    ["Post", "Posting", "Posted", "review findings"],
    "review-post",
    "pull-request",
  ),
  viewcode_list_agents: tool(["List", "Listing", "Listed", "agents"], "agent-list"),
  viewcode_list_models: tool(["List", "Listing", "Listed", "available models"], "model-list"),
  viewcode_spawn_agent: tool(["Start", "Starting", "Started", "a child agent"], "delegate"),
  viewcode_send_message: tool(["Send", "Sending", "Sent", "an agent message"], "thread-send"),
  viewcode_read_transcript: tool(["Read", "Reading", "Read", "an agent transcript"], "thread-read"),
  viewcode_search_history: tool(
    ["Search", "Searching", "Searched", "thread history"],
    "thread-search",
  ),
  viewcode_configure_agent: tool(
    ["Configure", "Configuring", "Configured", "an agent"],
    "thread-configure",
  ),
  viewcode_get_goal: tool(["Read", "Reading", "Read", "the thread goal"], "goal-read"),
  viewcode_set_goal: tool(["Update", "Updating", "Updated", "the thread goal"], "goal-update"),
  viewcode_get_debug_mode: tool(["Read", "Reading", "Read", "thread debug mode"], "debug-read"),
  viewcode_set_debug_mode: tool(
    ["Update", "Updating", "Updated", "thread debug mode"],
    "debug-update",
  ),
};
