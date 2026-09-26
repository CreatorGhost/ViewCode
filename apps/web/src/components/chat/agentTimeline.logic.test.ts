import { describe, expect, it } from "vite-plus/test";
import { EventId, type OrchestrationThreadActivity } from "@t3tools/contracts";
import { deriveWorkLogEntries } from "../../session-logic";
import {
  agentMessageBodyIsLong,
  agentToolkitLabel,
  handoffDividerLabel,
} from "./agentTimeline.logic";
import { liveWorkEntryLabel, workEntryDisplayLabel } from "./MessagesTimeline.logic";

function activity(
  kind: string,
  summary: string,
  payload: Record<string, unknown>,
): OrchestrationThreadActivity {
  return {
    id: EventId.make(`activity-${kind}`),
    createdAt: "2026-01-01T00:00:00.000Z",
    kind,
    summary,
    tone: "info",
    payload,
    turnId: null,
  };
}

describe("agentToolkitLabel", () => {
  it("names each agents toolkit call in plain words", () => {
    const entry = (toolTitle: string, toolLifecycleStatus?: "inProgress" | "completed") => ({
      label: "MCP tool call",
      toolTitle,
      ...(toolLifecycleStatus ? { toolLifecycleStatus } : {}),
    });
    expect(agentToolkitLabel(entry("t3-code · spawn_agent", "completed"))).toBe("Spawned agent");
    expect(agentToolkitLabel(entry("mcp__t3-code__send_message", "inProgress"))).toBe(
      "Messaging agent",
    );
    expect(agentToolkitLabel(entry("t3-code.list_agents"), "completed")).toBe("Listed agents");
    expect(agentToolkitLabel(entry("list_models"), "completed")).toBe("Listed models");
    // Current names carry the viewcode_ prefix; the bare names above are older sessions.
    expect(agentToolkitLabel(entry("mcp__t3-code__viewcode_spawn_agent", "completed"))).toBe(
      "Spawned agent",
    );
    expect(agentToolkitLabel(entry("t3-code.viewcode_send_message", "inProgress"))).toBe(
      "Messaging agent",
    );
    expect(agentToolkitLabel(entry("t3-code · read_transcript", "completed"))).toBe(
      "Read agent transcript",
    );
    expect(
      agentToolkitLabel({ ...entry("t3-code · configure_agent"), toolLifecycleStatus: "failed" }),
    ).toBe("Failed to configure agent");
    expect(agentToolkitLabel(entry("mcp__t3-code__viewcode_search_history", "inProgress"))).toBe(
      "Searching history",
    );
    expect(agentToolkitLabel(entry("t3-code.viewcode_search_history", "completed"))).toBe(
      "Searched history",
    );
  });

  it("reads the tool name from MCP tool data and ignores other servers", () => {
    expect(
      agentToolkitLabel(
        { label: "x", toolData: { server: "t3-code", tool: "spawn_agent" } },
        "completed",
      ),
    ).toBe("Spawned agent");
    expect(
      agentToolkitLabel({ label: "x", toolData: { server: "slack", tool: "send_message" } }),
    ).toBeNull();
    expect(agentToolkitLabel({ label: "Read file", toolTitle: "Read" })).toBeNull();
  });

  it("feeds the settled and live work row labels", () => {
    const entry = {
      id: "spawn",
      createdAt: "2026-01-01T00:00:00Z",
      label: "MCP tool call",
      toolTitle: "t3-code · spawn_agent",
      tone: "tool" as const,
    };
    expect(workEntryDisplayLabel(entry, undefined)).toBe("Spawned agent");
    expect(liveWorkEntryLabel(entry, undefined, true)).toBe("Spawning agent");
  });
});

describe("handoffDividerLabel", () => {
  it("shows model names only", () => {
    expect(
      handoffDividerLabel({
        label: "ignored",
        handoff: { fromModel: "claude-opus-4-6", toModel: "gpt-5-codex" },
      }),
    ).toBe("Context handed off · claude-opus-4-6 → gpt-5-codex");
    expect(
      handoffDividerLabel({
        label:
          "Context handed off from claude-opus-4-6 (claudeAgent) to claude-sonnet-4-6 (claudeWork)",
      }),
    ).toBe("Context handed off · claude-opus-4-6 → claude-sonnet-4-6");
    expect(handoffDividerLabel({ label: "Something else" })).toBe("Something else");
  });
});

describe("agent work log entries", () => {
  it("carries the handoff models and the sent-message payload", () => {
    const entries = deriveWorkLogEntries([
      activity("viewcode.handoff", "Context handed off", {
        from: { instanceId: "claudeAgent", model: "claude-opus-4-6" },
        to: { instanceId: "codex", model: "gpt-5-codex" },
      }),
      activity("viewcode.agent-message.sent", "Message to Reviewer", {
        messageId: "m-1",
        toThreadId: "thread-2",
        toName: "Reviewer",
        body: "Please review",
        replyExpected: true,
        inReplyTo: null,
        kind: "message",
        delivery: "queued",
      }),
    ]);
    const handoff = entries.find((entry) => entry.sourceActivityKind === "viewcode.handoff");
    const sent = entries.find(
      (entry) => entry.sourceActivityKind === "viewcode.agent-message.sent",
    );
    expect(handoff?.handoff).toEqual({ fromModel: "claude-opus-4-6", toModel: "gpt-5-codex" });
    expect(sent?.agentMessageSent).toEqual({
      messageId: "m-1",
      toThreadId: "thread-2",
      toName: "Reviewer",
      body: "Please review",
      replyExpected: true,
      inReplyTo: null,
      kind: "message",
      delivery: "queued",
    });
  });

  it("leaves a malformed sent payload as an ordinary entry", () => {
    const [entry] = deriveWorkLogEntries([
      activity("viewcode.agent-message.sent", "Message to ?", { toName: 3 }),
    ]);
    expect(entry?.agentMessageSent).toBeUndefined();
  });
});

describe("agentMessageBodyIsLong", () => {
  it("clamps bodies longer than three lines or a short paragraph", () => {
    expect(agentMessageBodyIsLong("One line")).toBe(false);
    expect(agentMessageBodyIsLong("a\nb\nc")).toBe(false);
    expect(agentMessageBodyIsLong("a\nb\nc\nd")).toBe(true);
    expect(agentMessageBodyIsLong("x".repeat(241))).toBe(true);
  });
});
