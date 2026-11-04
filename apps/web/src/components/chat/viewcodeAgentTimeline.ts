import type { OrchestrationThreadActivity } from "@t3tools/contracts";
import {
  readAgentMessageSentPayload,
  type AgentMessageSentPayload,
} from "@t3tools/shared/agentMessages";
import type { WorkLogEntry } from "../../session-logic";
import { isAgentMessagingToolCallWithCard } from "./agentTimeline.logic";

export interface ViewCodeAgentWorkMetadata {
  readonly agentMessageSent?: AgentMessageSentPayload;
  readonly handoff?: {
    readonly fromModel?: string;
    readonly toModel?: string;
    readonly fromInstanceId?: string;
    readonly toInstanceId?: string;
  };
}
const object = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const string = (value: unknown) => (typeof value === "string" ? value : undefined);

/** Presentation of optional ViewCode notices; native timeline items retain their own renderer. */
export function deriveViewCodeAgentWorkLogEntries(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): WorkLogEntry[] {
  return activities.flatMap((activity) => {
    const payload = object(activity.payload);
    const sent =
      activity.kind === "viewcode.agent-message.sent" ? readAgentMessageSentPayload(payload) : null;
    const from = object(payload?.from);
    const to = object(payload?.to);
    const status = string(payload?.status);
    const toolData = object(object(payload?.data)?.item) ?? payload?.data;
    const entry: WorkLogEntry = {
      id: activity.id,
      createdAt: activity.createdAt,
      label: activity.summary,
      tone: activity.tone === "error" ? "error" : "info",
      sourceActivityKind: activity.kind,
      itemType: "system_notice",
      ...(sent === null ? {} : { agentMessageSent: sent }),
      ...(activity.kind !== "viewcode.handoff"
        ? {}
        : {
            handoff: {
              ...(string(from?.model) === undefined ? {} : { fromModel: string(from?.model)! }),
              ...(string(to?.model) === undefined ? {} : { toModel: string(to?.model)! }),
              ...(string(from?.instanceId) === undefined
                ? {}
                : { fromInstanceId: string(from?.instanceId)! }),
              ...(string(to?.instanceId) === undefined
                ? {}
                : { toInstanceId: string(to?.instanceId)! }),
            },
          }),
      ...(payload?.itemType !== "mcp_tool_call"
        ? {}
        : {
            itemType: "dynamic_tool",
            toolTitle: activity.summary,
            toolData,
            ...(status === "failed" || status === "completed"
              ? { toolLifecycleStatus: status }
              : {}),
          }),
    };
    return isAgentMessagingToolCallWithCard(entry) ? [] : [entry];
  });
}
