import { describe, expect, it } from "vite-plus/test";
import { CursorSubagentEvents } from "./CursorSubagentEvents.ts";

describe("CursorSubagentEvents", () => {
  it("retains textual results alongside images and falls back from empty content", () => {
    const mapper = new CursorSubagentEvents();
    expect(
      mapper.update({
        toolCallId: "mixed",
        title: "Task: Audit",
        status: "completed",
        data: {
          content: [
            { type: "content", content: { type: "image", data: "image", mimeType: "image/png" } },
            { type: "content", content: { type: "text", text: "Audit passed" } },
          ],
        },
      }),
    ).toMatchObject({ type: "task.completed", payload: { summary: "Audit passed" } });
    expect(
      mapper.update({
        toolCallId: "empty",
        title: "Task: Audit",
        status: "completed",
        data: { content: [], rawOutput: "Raw result" },
      }),
    ).toMatchObject({ type: "task.completed", payload: { summary: "Raw result" } });
  });

  it("keeps separate tools with the same title and retains identity on sparse terminal updates", () => {
    const mapper = new CursorSubagentEvents();
    for (const toolCallId of ["a", "b"]) {
      expect(
        mapper.update({ toolCallId, title: "Task: Audit", status: "pending", data: {} }),
      ).toMatchObject({
        type: "task.started",
        payload: {
          taskId: toolCallId,
          title: "Audit",
          toolUseId: toolCallId,
          taskType: "subagent",
        },
      });
    }
    expect(mapper.update({ toolCallId: "b", status: "inProgress", data: {} })).toMatchObject({
      type: "task.progress",
      payload: { taskId: "b", status: "running" },
    });
    expect(
      mapper.update({ toolCallId: "a", status: "completed", data: { rawOutput: "Audit passed" } }),
    ).toMatchObject({
      type: "task.completed",
      payload: { taskId: "a", title: "Audit", status: "completed", summary: "Audit passed" },
    });
    expect(mapper.update({ toolCallId: "a", status: "pending", data: {} })).toEqual({
      type: "task.updated",
      payload: { taskId: "a", title: "Audit", toolUseId: "a", taskType: "subagent" },
    });
  });

  it("preserves failed and cancelled task states", () => {
    const mapper = new CursorSubagentEvents();
    expect(
      mapper.update({
        toolCallId: "failed",
        title: "Task: Review",
        status: "failed",
        data: { rawOutput: "Provider failed" },
      }),
    ).toMatchObject({
      type: "task.completed",
      payload: { status: "failed", summary: "Provider failed" },
    });
    expect(
      mapper.update({
        toolCallId: "cancelled",
        title: "Task: Review",
        status: "failed",
        detail: "Cancelled.",
        data: {},
      }),
    ).toMatchObject({ type: "task.updated", payload: { status: "cancelled" } });
  });

  it("leaves ordinary tools and task-list tools alone", () => {
    const mapper = new CursorSubagentEvents();
    for (const title of [
      "Read file",
      "TaskList",
      "TaskCreate",
      "Update tasks",
      "Task management",
    ]) {
      expect(
        mapper.update({ toolCallId: title, title, status: "pending", data: {} }),
      ).toBeUndefined();
    }
  });

  it("settles outstanding tasks on cancellation without changing completed tasks", () => {
    const mapper = new CursorSubagentEvents();
    mapper.update({ toolCallId: "a", title: "Task: Audit", status: "pending", data: {} });
    mapper.update({ toolCallId: "b", title: "Task: Audit", status: "completed", data: {} });
    expect(mapper.cancelActive()).toMatchObject([
      { type: "task.updated", payload: { taskId: "a", status: "cancelled" } },
    ]);
    expect(mapper.cancelActive()).toEqual([]);
    expect(mapper.update({ toolCallId: "a", status: "inProgress", data: {} })).toEqual({
      type: "task.updated",
      payload: { taskId: "a", toolUseId: "a", taskType: "subagent", title: "Audit" },
    });
  });
});
