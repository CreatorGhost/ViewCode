import { AGENT_MESSAGE_SENT_ACTIVITY_KIND } from "@t3tools/shared/agentMessages";
import { normalizeCompactToolLabel } from "@t3tools/client-runtime/work-log/presentation";
import type { WorkLogEntry } from "../../session-logic";

/** True for the sender-side record of a ViewCode agent-to-agent message. */
export function isAgentMessageSentActivityKind(kind: string | undefined): boolean {
  return kind === AGENT_MESSAGE_SENT_ACTIVITY_KIND;
}

const AGENT_TOOLKIT_LABELS: Readonly<
  Record<string, readonly [action: string, running: string, completed: string]>
> = {
  spawn_agent: ["Spawn agent", "Spawning agent", "Spawned agent"],
  send_message: ["Message agent", "Messaging agent", "Messaged agent"],
  list_agents: ["List agents", "Listing agents", "Listed agents"],
  list_models: ["List models", "Listing models", "Listed models"],
  read_transcript: ["Read agent transcript", "Reading agent transcript", "Read agent transcript"],
  configure_agent: ["Configure agent", "Configuring agent", "Configured agent"],
};

const T3_MCP_PREFIX =
  /^(?:mcp__(?:t3-code|t3_code|t3code)__|(?:t3-code|t3_code|t3code)(?:[.:/]|\s*·\s*))/i;

function agentToolkitToolName(value: string | undefined): string | null {
  if (!value) return null;
  // Tools are exposed as viewcode_<name> (older sessions used the bare name).
  const name = normalizeCompactToolLabel(value)
    .replace(T3_MCP_PREFIX, "")
    .replace(/^viewcode_/i, "");
  return Object.hasOwn(AGENT_TOOLKIT_LABELS, name) ? name : null;
}

/** The ViewCode agents MCP tool this entry calls, if any. */
export function resolveAgentToolkitToolName(
  entry: Pick<WorkLogEntry, "label" | "toolTitle" | "toolData">,
): string | null {
  const data = entry.toolData;
  if (data !== null && typeof data === "object") {
    if (
      "server" in data &&
      typeof data.server === "string" &&
      "tool" in data &&
      typeof data.tool === "string"
    ) {
      return agentToolkitToolName(`${data.server}.${data.tool}`);
    }
    if ("toolName" in data && typeof data.toolName === "string") {
      return agentToolkitToolName(data.toolName);
    }
  }
  return agentToolkitToolName(entry.toolTitle) ?? agentToolkitToolName(entry.label);
}

/**
 * Friendly label ("Spawned agent", "Messaging agent") for a call to the
 * ViewCode agents MCP toolkit; null for any other entry.
 */
export function agentToolkitLabel(
  entry: Pick<WorkLogEntry, "label" | "toolTitle" | "toolData" | "toolLifecycleStatus">,
  fallbackStatus?: "inProgress" | "completed",
): string | null {
  const name = resolveAgentToolkitToolName(entry);
  if (!name) return null;
  const [action, running, completed] = AGENT_TOOLKIT_LABELS[name]!;
  switch (entry.toolLifecycleStatus ?? fallbackStatus) {
    case "completed":
      return completed;
    case "failed":
      return `Failed to ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
    case "declined":
      return `Declined to ${action.charAt(0).toLowerCase()}${action.slice(1)}`;
    case "stopped":
      return `Stopped ${running.charAt(0).toLowerCase()}${running.slice(1)}`;
    default:
      return running;
  }
}

const AGENT_MESSAGE_CLAMP_LINES = 3;
const AGENT_MESSAGE_CLAMP_CHARS = 240;

/** Whether an agent message body overflows the card's three-line preview. */
export function agentMessageBodyIsLong(body: string): boolean {
  const trimmed = body.trim();
  return (
    trimmed.length > AGENT_MESSAGE_CLAMP_CHARS ||
    trimmed.split("\n").length > AGENT_MESSAGE_CLAMP_LINES
  );
}

const HANDOFF_SUMMARY = /^Context handed off from (\S+)(?: \([^)]*\))? to (\S+)(?: \([^)]*\))?$/;

/** "Context handed off · claude-opus-4-6 → gpt-5-codex" for a handoff divider. */
export function handoffDividerLabel(entry: Pick<WorkLogEntry, "label" | "handoff">): string {
  const fromModel = entry.handoff?.fromModel ?? HANDOFF_SUMMARY.exec(entry.label)?.[1];
  const toModel = entry.handoff?.toModel ?? HANDOFF_SUMMARY.exec(entry.label)?.[2];
  return fromModel && toModel ? `Context handed off · ${fromModel} → ${toModel}` : entry.label;
}
