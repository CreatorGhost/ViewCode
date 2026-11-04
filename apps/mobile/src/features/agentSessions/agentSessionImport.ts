import type { AgentSessionHiddenReason } from "@t3tools/contracts";

export const HIDDEN_REASON_LABELS: Record<AgentSessionHiddenReason, string> = {
  subagent: "Sub-agent",
  "agent-message": "Started by another agent",
  internal: "Internal run",
  "too-short": "Too short",
  "no-user-text": "No message of yours",
  "in-viewcode": "Already in ViewCode",
  "in-t3code": "Also in T3 Code",
};
