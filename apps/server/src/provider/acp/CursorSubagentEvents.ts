import { RuntimeTaskId, type ProviderRuntimeEvent } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AcpToolCallState } from "./AcpRuntimeModel.ts";

type TaskEvent = Extract<
  ProviderRuntimeEvent,
  { type: "task.started" | "task.progress" | "task.completed" | "task.updated" }
>;
type TaskUpdate = {
  [K in TaskEvent["type"]]: Pick<Extract<TaskEvent, { type: K }>, "type" | "payload">;
}[TaskEvent["type"]];

const decodeContent = Schema.decodeUnknownOption(Schema.Array(Schema.Unknown));
const decodeTextContent = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("content"),
    content: Schema.Struct({ type: Schema.Literal("text"), text: Schema.String }),
  }),
);

function resultText(tool: AcpToolCallState): string | undefined {
  const content = decodeContent(tool.data.content);
  const text = Option.isSome(content)
    ? content.value
        .flatMap((entry) => {
          const textEntry = decodeTextContent(entry);
          return Option.isSome(textEntry) ? [textEntry.value.content.text] : [];
        })
        .join("\n")
    : undefined;
  return (
    text?.trim().slice(0, 8_000) ||
    (typeof tool.data.rawOutput === "string"
      ? tool.data.rawOutput.trim().slice(0, 8_000)
      : undefined) ||
    (tool.detail !== tool.title ? tool.detail?.trim().slice(0, 8_000) : undefined)
  );
}

/** Cursor's native Task is an ACP tool, but its lifecycle belongs to the
 * shared agent roster. Keep identity across sparse updates and repeated
 * terminal notifications; titles are presentation, never identity. */
export class CursorSubagentEvents {
  private readonly tasks = new Map<string, { title: string; terminal: boolean }>();

  cancelActive(): TaskUpdate[] {
    const events: TaskUpdate[] = [];
    for (const [toolCallId, task] of this.tasks) {
      if (task.terminal) continue;
      task.terminal = true;
      events.push({
        type: "task.updated",
        payload: {
          taskId: RuntimeTaskId.make(toolCallId),
          toolUseId: toolCallId,
          taskType: "subagent",
          title: task.title,
          status: "cancelled",
        },
      });
    }
    return events;
  }

  update(tool: AcpToolCallState): TaskUpdate | undefined {
    const previous = this.tasks.get(tool.toolCallId);
    const taskTitle = tool.title?.match(/^Task(?:\s*:\s*(.*))?$/i);
    if (!previous && !taskTitle) return undefined;

    const title = taskTitle?.[1]?.trim() || previous?.title || "Cursor task";
    const terminal = tool.status === "completed" || tool.status === "failed";
    this.tasks.set(tool.toolCallId, { title, terminal: terminal || previous?.terminal === true });
    const linkage = {
      taskId: RuntimeTaskId.make(tool.toolCallId),
      toolUseId: tool.toolCallId,
      taskType: "subagent",
      title,
    };
    const summary = resultText(tool);
    if (terminal) {
      // Some ACP agents report cancellation as a failed tool with this detail.
      // Keep that cancellation distinct from a failed child.
      if (tool.status === "failed" && tool.detail === "Cancelled.") {
        return { type: "task.updated", payload: { ...linkage, status: "cancelled" } };
      }
      return {
        type: "task.completed",
        payload: {
          ...linkage,
          status: tool.status === "failed" ? "failed" : "completed",
          ...(summary ? { summary } : {}),
        },
      };
    }
    // Late pending updates must not reopen a completed task.
    if (previous?.terminal) {
      return { type: "task.updated", payload: linkage };
    }
    if (!previous) {
      return { type: "task.started", payload: { ...linkage, description: title } };
    }
    return {
      type: "task.progress",
      payload: {
        ...linkage,
        description: title,
        status: tool.status === "pending" ? "pending" : "running",
        ...(summary ? { summary } : {}),
      },
    };
  }
}
