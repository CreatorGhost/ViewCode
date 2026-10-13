#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
// A stand-in for `pi --mode rpc`: answers the RPC commands ViewCode sends and
// plays one canned run per prompt. Driven by environment variables:
//   PI_MOCK_LOG      append every received command here (JSON lines)
//   PI_MOCK_CONFIRM  ask `Allow bash?` through extension_ui_request before running bash
//   PI_MOCK_HANG     keep the run going until `abort`
//   PI_MOCK_FAIL     end the assistant message with a model error
//   PI_MOCK_NO_MODELS  report no usable models, as Pi without credentials does
import * as NodeFS from "node:fs";

const env = process.env;
// What ViewCode's extension would read, so tests can check the launch environment.
if (env.PI_MOCK_LOG) {
  NodeFS.appendFileSync(
    env.PI_MOCK_LOG,
    `${JSON.stringify({ type: "__env", mcp: env.VIEWCODE_PI_MCP_SERVER, mode: env.VIEWCODE_PI_RUNTIME_MODE })}\n`,
  );
}

type Record = { readonly [key: string]: unknown };
const write = (record: Record) => process.stdout.write(`${JSON.stringify(record)}\n`);
const respond = (command: Record, data?: unknown) =>
  write({ id: command.id, type: "response", command: command.type, success: true, data });

const pendingDialogs = new Map<string, (answer: Record) => void>();
let abortRun: (() => void) | undefined;
let running = false;

const ask = (request: Record) =>
  new Promise<Record>((resolve) => {
    pendingDialogs.set(String(request.id), resolve);
    write({ type: "extension_ui_request", ...request });
  });

async function run(message: string) {
  running = true;
  write({ type: "agent_start" });
  write({ type: "turn_start" });
  write({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Thinking." },
  });
  write({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `Echo: ${message}` },
  });
  write({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: `Echo: ${message}` }],
      usage: { input: 1000, output: 50, cacheRead: 200, cacheWrite: 0 },
      ...(env.PI_MOCK_FAIL === "1"
        ? { stopReason: "error", errorMessage: "403 The API key is invalid." }
        : { stopReason: "stop" }),
    },
  });
  if (env.PI_MOCK_CONFIRM === "1") {
    const answer = await ask({
      id: "dialog-1",
      method: "confirm",
      title: "Allow bash?",
      message: '{"command":"ls"}',
    });
    write({
      type: "tool_execution_start",
      toolCallId: "call-1",
      toolName: "bash",
      args: { command: "ls" },
    });
    write({
      type: "tool_execution_end",
      toolCallId: "call-1",
      toolName: "bash",
      result: {
        content: [{ type: "text", text: answer.confirmed === true ? "README.md" : "declined" }],
      },
      isError: answer.confirmed !== true,
    });
  }
  let aborted = false;
  if (env.PI_MOCK_HANG === "1") {
    await new Promise<void>((resolve) => {
      abortRun = () => {
        aborted = true;
        resolve();
      };
    });
  }
  running = false;
  write({ type: "agent_end", messages: [], willRetry: false });
  write({ type: "agent_settled", aborted });
}

function handle(command: Record) {
  if (env.PI_MOCK_LOG) NodeFS.appendFileSync(env.PI_MOCK_LOG, `${JSON.stringify(command)}\n`);
  switch (command.type) {
    case "get_state":
      return respond(command, {
        model: {
          provider: "anthropic",
          id: "claude-sonnet-5",
          contextWindow: 200_000,
          reasoning: true,
        },
        thinkingLevel: "medium",
        isStreaming: running,
        sessionFile: env.PI_MOCK_SESSION_FILE ?? "/tmp/pi-mock/session.jsonl",
        sessionId: "pi-mock-session",
      });
    case "get_available_models":
      return respond(command, {
        models:
          env.PI_MOCK_NO_MODELS === "1"
            ? []
            : [
                {
                  provider: "anthropic",
                  id: "claude-sonnet-5",
                  name: "Claude Sonnet 5",
                  reasoning: true,
                },
                { provider: "openai", id: "gpt-6-sol", name: "GPT-6 Sol", reasoning: false },
              ],
      });
    case "get_commands":
      return respond(command, {
        commands: [
          { name: "review", description: "Review the diff", source: "prompt" },
          {
            name: "skill:release",
            description: "Cut a release",
            source: "skill",
            sourceInfo: { path: "/skills/release" },
          },
        ],
      });
    case "set_model":
      return respond(command, {
        provider: command.provider,
        id: command.modelId,
        contextWindow: 100_000,
      });
    case "set_thinking_level":
      return respond(command);
    case "prompt":
      respond(command, { disposition: "started" });
      void run(String(command.message ?? ""));
      return;
    case "steer":
      respond(command, { disposition: "queued" });
      write({ type: "queue_update", steering: [command.message], followUp: [] });
      return;
    case "abort":
      abortRun?.();
      return respond(command);
    case "compact":
      write({ type: "compaction_start", reason: "manual" });
      write({
        type: "compaction_end",
        reason: "manual",
        result: { summary: "short" },
        aborted: false,
        willRetry: false,
      });
      return respond(command, { summary: "short", tokensBefore: 1000 });
    case "extension_ui_response": {
      const resolve = pendingDialogs.get(String(command.id));
      pendingDialogs.delete(String(command.id));
      resolve?.(command);
      return;
    }
    default:
      write({
        id: command.id,
        type: "response",
        command: command.type,
        success: false,
        error: "unknown command",
      });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) handle(JSON.parse(line) as Record);
    newline = buffer.indexOf("\n");
  }
});
process.stdin.on("end", () => process.exit(0));
