import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  buildCommandCodeTurnArgs,
  type CommandCodeEventDraft,
  commandCodeModelsFromList,
  makeCommandCodeTurnMapper,
  parseCommandCodeModelList,
  parseCommandCodeStatus,
  resolveCommandCodeBinary,
} from "./commandCodeCli.ts";

const SESSION_ID = "0b6c2f5e-6a53-4d1e-9d7e-2c1f0e8a9b71";
const USAGE = { inputTokens: 1200, outputTokens: 40, cacheReadTokens: 1000, cacheWriteTokens: 0 };

// Lines shaped exactly as `serializeAgentEventLine` / `buildPrintResultLine`
// print them in command-code 1.65.4 print mode with `--output-format json`.
const event = (value: Record<string, unknown>) => JSON.stringify({ type: "event", event: value });

function feed(lines: ReadonlyArray<string>, end = { exitCode: 0, interrupted: false, stderr: "" }) {
  const mapper = makeCommandCodeTurnMapper({ itemIdPrefix: "turn-1" });
  const drafts: Array<CommandCodeEventDraft> = [];
  for (const line of lines) drafts.push(...mapper.acceptLine(line));
  drafts.push(...mapper.finish(end));
  return { drafts, sessionId: mapper.sessionId() };
}

const summarize = (drafts: ReadonlyArray<CommandCodeEventDraft>) =>
  drafts.map((draft) => {
    switch (draft.type) {
      case "item.started":
      case "item.completed":
        return `${draft.type} ${draft.payload.itemType} ${draft.payload.status ?? ""} ${draft.itemId ?? ""}`.trim();
      case "content.delta":
        return `delta ${draft.payload.streamKind} ${JSON.stringify(draft.payload.delta)}`;
      case "turn.completed":
        return `turn.completed ${draft.payload.state}`;
      default:
        return draft.type;
    }
  });

describe("buildCommandCodeTurnArgs", () => {
  it("starts a fresh supervised turn without resume, model or yolo", () => {
    NodeAssert.deepEqual(buildCommandCodeTurnArgs({ fullAccess: false, model: "default" }), [
      "-p",
      "--output-format",
      "json",
      "--skip-onboarding",
      "--no-auto-update",
    ]);
  });

  it("resumes the session, pins the model and lifts the write gate in full access", () => {
    NodeAssert.deepEqual(
      buildCommandCodeTurnArgs({
        resumeSessionId: SESSION_ID,
        model: "moonshotai/kimi-k2.6",
        fullAccess: true,
        addDirs: ["/state/attachments"],
      }),
      [
        "-p",
        "--output-format",
        "json",
        "--skip-onboarding",
        "--no-auto-update",
        "--resume",
        SESSION_ID,
        "--model",
        "moonshotai/kimi-k2.6",
        "--yolo",
        "--add-dir",
        "/state/attachments",
      ],
    );
  });

  it("never runs Windows' own cmd.exe", () => {
    NodeAssert.equal(resolveCommandCodeBinary("", "win32"), "command-code");
    NodeAssert.equal(resolveCommandCodeBinary("cmd", "linux"), "cmd");
    NodeAssert.equal(resolveCommandCodeBinary("/opt/cmd", "win32"), "/opt/cmd");
  });
});

describe("makeCommandCodeTurnMapper", () => {
  it("maps a full-access turn with reasoning, a shell tool and a final answer", () => {
    const { drafts, sessionId } = feed([
      event({ type: "run_start", sessionId: SESSION_ID }),
      event({ type: "turn_start", turnNumber: 1 }),
      event({ type: "message_start" }),
      event({ type: "model_request_start", model: "deepseek/deepseek-v4-flash" }),
      event({ type: "thinking_start" }),
      event({ type: "thinking_delta", delta: "List the files." }),
      event({ type: "thinking_end", text: "List the files." }),
      event({ type: "text_delta", delta: "Let me " }),
      event({ type: "text_delta", delta: "look." }),
      event({
        type: "model_request_end",
        model: "deepseek/deepseek-v4-flash",
        usage: USAGE,
        stopReason: "tool-calls",
      }),
      event({
        type: "message_end",
        content: [
          { type: "text", text: "Let me look." },
          { type: "tool_use", id: "call_1", name: "shell_command", input: { command: "ls" } },
        ],
      }),
      event({
        type: "tool_queued",
        toolCallId: "call_1",
        toolName: "shell_command",
        input: { command: "ls" },
      }),
      event({ type: "tool_running", toolCallId: "call_1", toolName: "shell_command" }),
      event({
        type: "tool_completed",
        toolCallId: "call_1",
        toolName: "shell_command",
        result: [{ type: "text", text: "a.txt\nb.txt" }],
      }),
      event({ type: "turn_end", turnNumber: 1, hadToolCalls: true, usage: USAGE }),
      event({ type: "message_start" }),
      event({ type: "text_delta", delta: "Two files." }),
      event({ type: "model_request_end", usage: USAGE, stopReason: "stop" }),
      event({ type: "message_end", content: [{ type: "text", text: "Two files." }] }),
      event({
        type: "run_end",
        result: {
          finalText: "Two files.",
          stopReason: "end_turn",
          turnCount: 2,
          usage: USAGE,
          nextState: { messages: [] },
        },
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        sessionId: SESSION_ID,
        stopReason: "end_turn",
        usage: { inputTokens: 2400, outputTokens: 80, cacheReadTokens: 2000, cacheWriteTokens: 0 },
        durationMs: 5120,
        finalText: "Two files.",
      }),
    ]);

    NodeAssert.equal(sessionId, SESSION_ID);
    NodeAssert.deepEqual(summarize(drafts), [
      "item.started reasoning inProgress turn-1:reasoning:1",
      'delta reasoning_text "List the files."',
      "item.completed reasoning completed turn-1:reasoning:1",
      "item.started assistant_message inProgress turn-1:assistant:2",
      'delta assistant_text "Let me "',
      'delta assistant_text "look."',
      "thread.token-usage.updated",
      "item.completed assistant_message completed turn-1:assistant:2",
      "item.started command_execution inProgress turn-1:tool:call_1",
      'delta command_output "a.txt\\nb.txt"',
      "item.completed command_execution completed turn-1:tool:call_1",
      "item.started assistant_message inProgress turn-1:assistant:3",
      'delta assistant_text "Two files."',
      "thread.token-usage.updated",
      "item.completed assistant_message completed turn-1:assistant:3",
      "turn.completed completed",
    ]);

    const assistant = drafts.find(
      (draft) => draft.type === "item.completed" && draft.itemId === "turn-1:assistant:2",
    );
    NodeAssert.equal(
      assistant?.type === "item.completed" && assistant.payload.detail,
      "Let me look.",
    );
    const tool = drafts.find(
      (draft) => draft.type === "item.started" && draft.payload.itemType === "command_execution",
    );
    NodeAssert.equal(tool?.type === "item.started" && tool.payload.detail, "shell_command: ls");
    const completed = drafts.at(-1);
    NodeAssert.deepEqual(completed?.type === "turn.completed" && completed.payload, {
      state: "completed",
      stopReason: "end_turn",
      tokenUsage: {
        usageScope: "main_agent",
        usageStatus: "complete",
        inputTokens: 2400,
        outputTokens: 80,
        cachedInputTokens: 2000,
        hasSubagents: false,
      },
    });
  });

  it("shows writes blocked by the supervised print gate as declined", () => {
    const blocked =
      'Error: Tool "write_file" requires permissions. Use --yolo (or --dangerously-skip-permissions) to enable file writes and shell commands in print mode.';
    const { drafts } = feed([
      event({ type: "run_start", sessionId: SESSION_ID }),
      event({
        type: "tool_queued",
        toolCallId: "call_9",
        toolName: "write_file",
        input: { file_path: "notes.md", content: "hi" },
      }),
      event({
        type: "tool_hook_blocked",
        toolCallId: "call_9",
        toolName: "write_file",
        hookOutput: blocked,
      }),
      JSON.stringify({
        type: "result",
        subtype: "success",
        sessionId: SESSION_ID,
        stopReason: "end_turn",
        usage: USAGE,
        durationMs: 10,
        finalText: "I could not write the file.",
      }),
    ]);
    const declined = drafts.find((draft) => draft.type === "item.completed");
    NodeAssert.equal(declined?.type === "item.completed" && declined.payload.status, "declined");
    NodeAssert.equal(
      declined?.type === "item.completed" && declined.payload.itemType,
      "file_change",
    );
    NodeAssert.equal(declined?.type === "item.completed" && declined.payload.detail, blocked);
  });

  it("fails the turn with the CLI's error when it is not logged in", () => {
    // Captured from `echo hi | cmd -p --output-format json` with no login.
    const { drafts, sessionId } = feed(
      [
        '{"type":"result","subtype":"error","usage":{"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0},"durationMs":4,"finalText":"","error":"Error: Not authenticated. Please run \\"cmd login\\" first."}',
      ],
      {
        exitCode: 3,
        interrupted: false,
        stderr: 'Error: Not authenticated. Please run "cmd login" first.\n',
      },
    );
    NodeAssert.equal(sessionId, undefined);
    const completed = drafts.at(-1);
    NodeAssert.equal(completed?.type === "turn.completed" && completed.payload.state, "failed");
    NodeAssert.equal(
      completed?.type === "turn.completed" && completed.payload.errorMessage,
      'Error: Not authenticated. Please run "cmd login" first.',
    );
    NodeAssert.ok(drafts.some((draft) => draft.type === "runtime.error"));
  });

  it("aborts an interrupted turn and fails the tool it was running", () => {
    const { drafts } = feed(
      [
        event({ type: "run_start", sessionId: SESSION_ID }),
        event({ type: "text_delta", delta: "Running tests" }),
        event({
          type: "tool_queued",
          toolCallId: "call_2",
          toolName: "shell_command",
          input: { command: "pnpm test" },
        }),
      ],
      { exitCode: 130, interrupted: true, stderr: "\nTerminated.\n" },
    );
    NodeAssert.deepEqual(summarize(drafts), [
      "item.started assistant_message inProgress turn-1:assistant:1",
      'delta assistant_text "Running tests"',
      "item.completed assistant_message completed turn-1:assistant:1",
      "item.started command_execution inProgress turn-1:tool:call_2",
      "item.completed command_execution failed turn-1:tool:call_2",
      "turn.aborted",
    ]);
  });

  it("ignores noise and unknown events", () => {
    const { drafts } = feed([
      "not json",
      event({ type: "session_titled", title: "x" }),
      event({ type: "notice", level: "info", message: "hello" }),
      JSON.stringify({ type: "result", subtype: "success", usage: USAGE, finalText: "ok" }),
    ]);
    NodeAssert.deepEqual(summarize(drafts), ["turn.completed completed"]);
  });
});

describe("parseCommandCodeModelList", () => {
  // Excerpt of `cmd --list-models` from command-code 1.65.4.
  const output = [
    "Available models  ·  81 models",
    "",
    "Open Source",
    "",
    "deepseek/deepseek-v4-pro               hybrid-attention long-context reasoning",
    "deepseek/deepseek-v4-flash             fast hybrid-attention reasoning (default)",
    "",
    "Anthropic",
    "",
    "claude-sonnet-5                        best combo of speed & intelligence (recommended)",
    "",
    'Pass the full id, or just the short name after the last "/":',
    "cmd --model moonshotai/kimi-k2.5",
    "",
    "Decision models (headless only)",
    "typesafe/jev  typed questions in, probabilities out",
  ].join("\n");

  it("reads groups, marks the CLI default and stops at the footer", () => {
    NodeAssert.deepEqual(parseCommandCodeModelList(output), [
      {
        slug: "deepseek/deepseek-v4-pro",
        description: "hybrid-attention long-context reasoning",
        group: "Open Source",
        isCliDefault: false,
      },
      {
        slug: "deepseek/deepseek-v4-flash",
        description: "fast hybrid-attention reasoning",
        group: "Open Source",
        isCliDefault: true,
      },
      {
        slug: "claude-sonnet-5",
        description: "best combo of speed & intelligence (recommended)",
        group: "Anthropic",
        isCliDefault: false,
      },
    ]);
  });

  it("leads the picker with the CLI's own default", () => {
    const models = commandCodeModelsFromList(parseCommandCodeModelList(output));
    NodeAssert.deepEqual(
      models.map((model) => [model.slug, model.isDefault === true, model.subProvider]),
      [
        ["default", true, undefined],
        ["deepseek/deepseek-v4-pro", false, "Open Source"],
        ["deepseek/deepseek-v4-flash", false, "Open Source"],
        ["claude-sonnet-5", false, "Anthropic"],
      ],
    );
    NodeAssert.equal(models[0]?.name, "Default (deepseek/deepseek-v4-flash)");
  });
});

describe("parseCommandCodeStatus", () => {
  it("reads `cmd status --json`", () => {
    NodeAssert.deepEqual(parseCommandCodeStatus('{"authenticated":false,"version":"1.65.4"}\n'), {
      authenticated: false,
      version: "1.65.4",
    });
    NodeAssert.equal(parseCommandCodeStatus("Not logged in"), undefined);
  });
});
