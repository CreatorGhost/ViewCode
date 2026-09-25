/**
 * Command Code (`cmd`, npm `command-code`) headless protocol: argv, NDJSON
 * decoding, and the mapping from its agent events to canonical runtime
 * events. Pure, so the adapter only owns processes and stamping.
 *
 * What the CLI does, read from `command-code@1.65.4` `dist/cli.mjs`:
 *
 * - Print mode is `-p, --print [query]`. With no query and a non-TTY stdin it
 *   reads the whole prompt from stdin (`resolvePrintInputSource`), so prompts
 *   go over stdin and never hit argv limits.
 * - `--output-format json` (choices `text` | `json`) writes one
 *   `{"type":"event","event":<AgentEvent>}` line per agent event
 *   (`serializeAgentEventLine`) and a final
 *   `{"type":"result","subtype":"success"|"max_turns"|"error","sessionId"?,
 *   "stopReason"?,"usage","durationMs","finalText","error"?}` line
 *   (`buildPrintResultLine`). Early failures such as a missing login print
 *   only the result line, without a session id, and exit non-zero (auth: 3).
 * - The session id is a fresh UUID per run unless resumed. It appears in the
 *   first `run_start` event (`{type:"run_start",sessionId}`) and in the result
 *   line. `--verbose` also prints `session: <id>` on stderr; not needed here.
 * - `--resume <id>` continues a transcript under
 *   `~/.commandcode/projects/<cwd slug>/` and keeps the same id; print mode
 *   rejects a bare `--resume`. `--continue` picks the newest headless session.
 * - `-m, --model <id>` rejects unknown ids; `--list-models` prints the table
 *   `parseCommandCodeModelList` reads.
 * - Without `--yolo` (alias of `--dangerously-skip-permissions`) print mode
 *   installs a gate that blocks `edit_file`, `write_file`, `shell_command`,
 *   `monitor_command` and `kill_shell`, emitting `tool_hook_blocked`. There
 *   is no interactive approval channel headless. `--permission-mode yolo`
 *   alone does not lift that gate.
 * - `--add-dir <dir>` grants extra directories. There is no working-directory
 *   flag (the process cwd is the project) and no per-run MCP config flag.
 * - SIGINT/SIGTERM abort the run and exit without a result line.
 * - `cmd status --json` prints `{"authenticated":boolean,"version":string}`.
 *
 * AgentEvent shapes (from `agentLoop`, `runTools`, `executeOne`):
 * `run_start{sessionId}`, `turn_start{turnNumber}`, `message_start`,
 * `model_request_start{model}`, `text_delta{delta}`, `thinking_start`,
 * `thinking_delta{delta}`, `thinking_end{text}`, `message_update{content}`,
 * `model_request_end{model,usage,stopReason}`, `message_end{content}`,
 * `tool_queued{toolCallId,toolName,input}`, `tool_denied{toolCallId,toolName}`,
 * `tool_hook_blocked{toolCallId,toolName,hookOutput}`,
 * `tool_running{toolCallId,toolName,description}`,
 * `tool_update{toolCallId,toolName,partial}`,
 * `tool_completed{toolCallId,toolName,result:[{type:"text",text}...]}`,
 * `tool_errored{toolCallId,toolName,error}`, `turn_end{turnNumber,...}`,
 * `notice{level,message}`, `api_retry{attempt,error,delayMs}`,
 * `stream_restart{attempt,maxAttempts,discardedVisibleContent}`,
 * `run_error{error:{name,message}}`, `interrupted`, and
 * `run_end{result:{finalText,stopReason,turnCount,usage,...}}`. Usage is
 * `{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`, where input
 * includes cache reads and writes (AI SDK totals).
 */
import {
  COMMAND_CODE_DEFAULT_MODEL,
  type CanonicalItemType,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ServerProviderModel,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export interface CommandCodeTurnArgsInput {
  /** Native session to continue; omitted on a thread's first turn. */
  readonly resumeSessionId?: string | undefined;
  readonly model?: string | undefined;
  /** Full access lifts the print-mode write/shell gate with `--yolo`. */
  readonly fullAccess: boolean;
  readonly addDirs?: ReadonlyArray<string>;
}

/** Argv for one headless turn. The prompt itself is written to stdin. */
export function buildCommandCodeTurnArgs(input: CommandCodeTurnArgsInput): Array<string> {
  const model = input.model?.trim();
  return [
    "-p",
    "--output-format",
    "json",
    "--skip-onboarding",
    "--no-auto-update",
    ...(input.resumeSessionId ? ["--resume", input.resumeSessionId] : []),
    ...(model && model !== COMMAND_CODE_DEFAULT_MODEL ? ["--model", model] : []),
    ...(input.fullAccess ? ["--yolo"] : []),
    ...(input.addDirs ?? []).flatMap((directory) => ["--add-dir", directory]),
  ];
}

/** `cmd` is also Windows' shell, so Windows spawns the package's `command-code` bin instead. */
export function resolveCommandCodeBinary(binaryPath: string, platform: NodeJS.Platform): string {
  const configured = binaryPath.trim() || "cmd";
  return platform === "win32" && configured.toLowerCase() === "cmd" ? "command-code" : configured;
}

const Usage = Schema.Struct({
  inputTokens: Schema.optionalKey(Schema.Number),
  outputTokens: Schema.optionalKey(Schema.Number),
  cacheReadTokens: Schema.optionalKey(Schema.Number),
  cacheWriteTokens: Schema.optionalKey(Schema.Number),
});
type Usage = typeof Usage.Type;

const ToolRef = {
  toolCallId: Schema.String,
  toolName: Schema.String,
};

const AgentEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("run_start"), sessionId: Schema.String }),
  Schema.Struct({ type: Schema.Literal("message_start") }),
  Schema.Struct({ type: Schema.Literal("text_delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking_start") }),
  Schema.Struct({ type: Schema.Literal("thinking_delta"), delta: Schema.String }),
  Schema.Struct({ type: Schema.Literal("thinking_end") }),
  Schema.Struct({ type: Schema.Literal("message_end") }),
  Schema.Struct({
    type: Schema.Literal("model_request_start"),
    model: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("model_request_end"), usage: Usage }),
  Schema.Struct({ type: Schema.Literal("tool_queued"), ...ToolRef, input: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("tool_completed"), ...ToolRef, result: Schema.Unknown }),
  Schema.Struct({ type: Schema.Literal("tool_errored"), ...ToolRef, error: Schema.String }),
  Schema.Struct({ type: Schema.Literal("tool_denied"), ...ToolRef }),
  Schema.Struct({
    type: Schema.Literal("tool_hook_blocked"),
    ...ToolRef,
    hookOutput: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("notice"), level: Schema.String, message: Schema.String }),
  Schema.Struct({
    type: Schema.Literal("api_retry"),
    attempt: Schema.Number,
    error: Schema.String,
  }),
  Schema.Struct({ type: Schema.Literal("stream_restart") }),
  Schema.Struct({ type: Schema.Literal("run_error"), error: Schema.Unknown }),
]);
type AgentEvent = typeof AgentEvent.Type;

const OutputLine = Schema.Union([
  Schema.Struct({ type: Schema.Literal("event"), event: Schema.Unknown }),
  Schema.Struct({
    type: Schema.Literal("result"),
    subtype: Schema.String,
    sessionId: Schema.optionalKey(Schema.String),
    stopReason: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(Usage),
    finalText: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(Schema.String),
  }),
]);
type ResultLine = Extract<typeof OutputLine.Type, { type: "result" }>;

const decodeOutputLine = Schema.decodeUnknownOption(Schema.fromJsonString(OutputLine));
const decodeAgentEvent = Schema.decodeUnknownOption(AgentEvent);
const ErrorLike = Schema.Struct({ message: Schema.String });
const decodeErrorLike = Schema.decodeUnknownOption(ErrorLike);
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String });
const decodeTextBlocks = Schema.decodeUnknownOption(
  Schema.Array(Schema.Union([TextBlock, Schema.Struct({ type: Schema.String })])),
);

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A canonical event before the adapter stamps ids, time, thread and turn. */
export type CommandCodeEventDraft = DistributiveOmit<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt" | "turnId"
>;

export interface CommandCodeTurnEnd {
  /** Exit code, or null when the process could not be observed. */
  readonly exitCode: number | null;
  /** True when T3 killed the process to stop the turn. */
  readonly interrupted: boolean;
  /** Tail of stderr, used when the CLI died without a result line. */
  readonly stderr: string;
}

export interface CommandCodeTurnMapper {
  readonly acceptLine: (line: string) => ReadonlyArray<CommandCodeEventDraft>;
  readonly finish: (end: CommandCodeTurnEnd) => ReadonlyArray<CommandCodeEventDraft>;
  /** Native session id, once `run_start` or the result line reported it. */
  readonly sessionId: () => string | undefined;
}

interface OpenTextItem {
  readonly itemId: RuntimeItemId;
  text: string;
}

interface OpenTool {
  readonly itemId: RuntimeItemId;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly input: unknown;
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function classifyCommandCodeTool(toolName: string): CanonicalItemType {
  const name = toolName.toLowerCase();
  if (name.includes("shell") || name.includes("command") || name.includes("bash")) {
    return "command_execution";
  }
  if (name === "edit_file" || name === "write_file" || name.includes("patch")) {
    return "file_change";
  }
  if (name.startsWith("web_search")) return "web_search";
  if (name.includes("agent") || name === "task") return "collab_agent_tool_call";
  if (name.startsWith("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function toolTitle(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "web_search":
      return "Web search";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "mcp_tool_call":
      return "MCP tool call";
    default:
      return "Tool call";
  }
}

function toolDetail(toolName: string, input: unknown): string | undefined {
  if (!isRecord(input)) return nonEmpty(toolName);
  for (const key of ["command", "file_path", "path", "filePath", "query", "url", "pattern"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(`${toolName}: ${value.trim()}`, 400);
    }
  }
  return nonEmpty(toolName);
}

function toolResultText(result: unknown): string {
  if (typeof result === "string") return result;
  return Option.match(decodeTextBlocks(result), {
    onNone: () => "",
    onSome: (blocks) =>
      blocks
        .flatMap((block) => ("text" in block && typeof block.text === "string" ? [block.text] : []))
        .join("\n"),
  });
}

function errorMessage(error: unknown): string | undefined {
  if (typeof error === "string") return nonEmpty(error);
  return Option.match(decodeErrorLike(error), {
    onNone: () => undefined,
    onSome: (decoded) => nonEmpty(decoded.message),
  });
}

function toNonNegativeInt(value: number | undefined): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function commandCodeTurnTokenUsage(usage: Usage): TurnTokenUsage {
  const cachedInputTokens = toNonNegativeInt(usage.cacheReadTokens);
  const cacheCreationTokens = toNonNegativeInt(usage.cacheWriteTokens);
  return {
    usageScope: "main_agent",
    usageStatus: "complete",
    inputTokens: toNonNegativeInt(usage.inputTokens),
    outputTokens: toNonNegativeInt(usage.outputTokens),
    ...(cachedInputTokens > 0 ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens > 0 ? { cacheCreationTokens } : {}),
    hasSubagents: false,
  };
}

/**
 * Stateful mapper for one `cmd -p` process. `itemIdPrefix` must be unique per
 * turn: assistant and reasoning segments are numbered under it, and tool items
 * use the CLI's tool call ids under it.
 */
export function makeCommandCodeTurnMapper(input: {
  readonly itemIdPrefix: string;
  readonly knownSessionId?: string | undefined;
}): CommandCodeTurnMapper {
  let sessionId = input.knownSessionId;
  let segment = 0;
  let assistant: OpenTextItem | undefined;
  let reasoning: OpenTextItem | undefined;
  const tools = new Map<string, OpenTool>();
  const usageTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  let sawUsage = false;
  let result: ResultLine | undefined;
  let runError: string | undefined;
  let finished = false;

  const nextItemId = (kind: string) => {
    segment += 1;
    return RuntimeItemId.make(`${input.itemIdPrefix}:${kind}:${segment}`);
  };

  const closeAssistant = (): Array<CommandCodeEventDraft> => {
    const open = assistant;
    assistant = undefined;
    if (!open) return [];
    const detail = nonEmpty(open.text);
    return [
      {
        type: "item.completed",
        itemId: open.itemId,
        payload: {
          itemType: "assistant_message",
          status: "completed",
          title: "Assistant message",
          ...(detail ? { detail } : {}),
        },
      },
    ];
  };

  const closeReasoning = (): Array<CommandCodeEventDraft> => {
    const open = reasoning;
    reasoning = undefined;
    if (!open) return [];
    return [
      {
        type: "item.completed",
        itemId: open.itemId,
        payload: { itemType: "reasoning", status: "completed", title: "Reasoning" },
      },
    ];
  };

  const settleTool = (
    toolCallId: string,
    status: "completed" | "failed" | "declined",
    output: string | undefined,
  ): Array<CommandCodeEventDraft> => {
    const tool = tools.get(toolCallId);
    if (!tool) return [];
    tools.delete(toolCallId);
    const drafts: Array<CommandCodeEventDraft> = [];
    const streamKind =
      tool.itemType === "command_execution"
        ? "command_output"
        : tool.itemType === "file_change"
          ? "file_change_output"
          : undefined;
    if (status === "completed" && streamKind && output) {
      drafts.push({
        type: "content.delta",
        itemId: tool.itemId,
        payload: { streamKind, delta: output },
      });
    }
    const detail = status === "completed" ? tool.detail : (nonEmpty(output) ?? tool.detail);
    drafts.push({
      type: "item.completed",
      itemId: tool.itemId,
      payload: {
        itemType: tool.itemType,
        status,
        title: tool.title,
        ...(detail ? { detail: truncate(detail, 2000) } : {}),
        data: {
          toolName: tool.toolName,
          input: tool.input,
          ...(output !== undefined ? { result: output } : {}),
        },
      },
    });
    return drafts;
  };

  const handleEvent = (event: AgentEvent): Array<CommandCodeEventDraft> => {
    switch (event.type) {
      case "run_start":
        sessionId = event.sessionId;
        return [];
      case "message_start":
        return [...closeReasoning(), ...closeAssistant()];
      case "text_delta": {
        if (event.delta.length === 0) return [];
        const drafts: Array<CommandCodeEventDraft> = [...closeReasoning()];
        if (!assistant) {
          assistant = { itemId: nextItemId("assistant"), text: "" };
          drafts.push({
            type: "item.started",
            itemId: assistant.itemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        assistant.text += event.delta;
        drafts.push({
          type: "content.delta",
          itemId: assistant.itemId,
          payload: { streamKind: "assistant_text", delta: event.delta },
        });
        return drafts;
      }
      case "thinking_start":
        return [];
      case "thinking_delta": {
        if (event.delta.length === 0) return [];
        const drafts: Array<CommandCodeEventDraft> = [];
        if (!reasoning) {
          reasoning = { itemId: nextItemId("reasoning"), text: "" };
          drafts.push({
            type: "item.started",
            itemId: reasoning.itemId,
            payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
          });
        }
        reasoning.text += event.delta;
        drafts.push({
          type: "content.delta",
          itemId: reasoning.itemId,
          payload: { streamKind: "reasoning_text", delta: event.delta },
        });
        return drafts;
      }
      case "thinking_end":
        return closeReasoning();
      case "message_end":
        return [...closeReasoning(), ...closeAssistant()];
      case "model_request_start":
        return [];
      case "model_request_end": {
        sawUsage = true;
        usageTotals.inputTokens += toNonNegativeInt(event.usage.inputTokens);
        usageTotals.outputTokens += toNonNegativeInt(event.usage.outputTokens);
        usageTotals.cacheReadTokens += toNonNegativeInt(event.usage.cacheReadTokens);
        usageTotals.cacheWriteTokens += toNonNegativeInt(event.usage.cacheWriteTokens);
        const lastInputTokens = toNonNegativeInt(event.usage.inputTokens);
        const lastOutputTokens = toNonNegativeInt(event.usage.outputTokens);
        const lastCachedInputTokens = toNonNegativeInt(event.usage.cacheReadTokens);
        // The latest request's input plus output approximates the context in use.
        const usedTokens = lastInputTokens + lastOutputTokens;
        if (usedTokens === 0) return [];
        return [
          {
            type: "thread.token-usage.updated",
            payload: {
              usage: {
                usedTokens,
                lastUsedTokens: usedTokens,
                lastInputTokens,
                lastOutputTokens,
                ...(lastCachedInputTokens > 0 ? { lastCachedInputTokens } : {}),
                inputTokens: usageTotals.inputTokens,
                outputTokens: usageTotals.outputTokens,
                ...(usageTotals.cacheReadTokens > 0
                  ? { cachedInputTokens: usageTotals.cacheReadTokens }
                  : {}),
              },
            },
          },
        ];
      }
      case "tool_queued": {
        const itemType = classifyCommandCodeTool(event.toolName);
        const tool: OpenTool = {
          itemId: RuntimeItemId.make(`${input.itemIdPrefix}:tool:${event.toolCallId}`),
          itemType,
          toolName: event.toolName,
          title: toolTitle(itemType),
          detail: toolDetail(event.toolName, event.input),
          input: event.input,
        };
        tools.set(event.toolCallId, tool);
        return [
          ...closeReasoning(),
          ...closeAssistant(),
          {
            type: "item.started",
            itemId: tool.itemId,
            payload: {
              itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: { toolName: tool.toolName, input: tool.input },
            },
          },
        ];
      }
      case "tool_completed":
        return settleTool(event.toolCallId, "completed", toolResultText(event.result));
      case "tool_errored":
        return settleTool(event.toolCallId, "failed", event.error);
      case "tool_denied":
        return settleTool(event.toolCallId, "declined", "Command Code denied this tool call.");
      case "tool_hook_blocked":
        return settleTool(event.toolCallId, "declined", event.hookOutput);
      case "notice": {
        const message = nonEmpty(event.message);
        return event.level === "warning" && message
          ? [{ type: "runtime.warning", payload: { message } }]
          : [];
      }
      case "api_retry": {
        const message = nonEmpty(event.error);
        return [
          {
            type: "runtime.warning",
            payload: {
              message: `Command Code is retrying the model request (attempt ${event.attempt})${
                message ? `: ${truncate(message, 300)}` : "."
              }`,
            },
          },
        ];
      }
      case "stream_restart":
        return [
          {
            type: "runtime.warning",
            payload: {
              message: "Command Code restarted the model stream. Some streamed text may repeat.",
            },
          },
        ];
      case "run_error":
        runError = errorMessage(event.error) ?? "Command Code run failed.";
        return [];
    }
  };

  const acceptLine: CommandCodeTurnMapper["acceptLine"] = (line) => {
    if (finished) return [];
    const trimmed = line.trim();
    if (!trimmed) return [];
    const decoded = decodeOutputLine(trimmed);
    if (Option.isNone(decoded)) return [];
    const output = decoded.value;
    if (output.type === "result") {
      result = output;
      if (output.sessionId) sessionId = output.sessionId;
      return [];
    }
    const event = decodeAgentEvent(output.event);
    return Option.isSome(event) ? handleEvent(event.value) : [];
  };

  const finish: CommandCodeTurnMapper["finish"] = (end) => {
    if (finished) return [];
    finished = true;
    const drafts: Array<CommandCodeEventDraft> = [...closeReasoning(), ...closeAssistant()];
    for (const toolCallId of tools.keys()) {
      drafts.push(
        ...settleTool(
          toolCallId,
          "failed",
          end.interrupted ? "Stopped before the tool finished." : undefined,
        ),
      );
    }
    const usage = result?.usage ?? (sawUsage ? usageTotals : undefined);
    const tokenUsage = usage ? commandCodeTurnTokenUsage(usage) : undefined;
    if (end.interrupted) {
      drafts.push({
        type: "turn.aborted",
        payload: { reason: "Interrupted by user.", ...(tokenUsage ? { tokenUsage } : {}) },
      });
      return drafts;
    }
    if (result && result.subtype !== "error") {
      drafts.push({
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: nonEmpty(result.stopReason) ?? null,
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      });
      return drafts;
    }
    const stderrMessage = nonEmpty(end.stderr.split("\n").slice(-5).join("\n"));
    const message =
      nonEmpty(result?.error) ??
      runError ??
      stderrMessage ??
      (end.exitCode === null
        ? "Command Code exited unexpectedly."
        : `Command Code exited with code ${end.exitCode}.`);
    drafts.push(
      {
        type: "runtime.error",
        payload: { message: truncate(message, 2000), class: "provider_error" },
      },
      {
        type: "turn.completed",
        payload: {
          state: "failed",
          errorMessage: truncate(message, 2000),
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      },
    );
    return drafts;
  };

  return { acceptLine, finish, sessionId: () => sessionId };
}

export interface CommandCodeListedModel {
  readonly slug: string;
  readonly description: string | undefined;
  readonly group: string | undefined;
  readonly isCliDefault: boolean;
}

/**
 * Parses `cmd --list-models`: group headings, then `<id>  <description>`
 * rows. Parsing stops at the usage footer so the headless-only decision
 * models after it are never offered as chat models.
 */
export function parseCommandCodeModelList(output: string): ReadonlyArray<CommandCodeListedModel> {
  const models: Array<CommandCodeListedModel> = [];
  const seen = new Set<string>();
  let group: string | undefined;
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (/^(Pass the full id|Docs:|Decision models)/.test(line.trim())) break;
    if (/^Available models\b/.test(line.trim())) continue;
    const row = /^(\S+)\s{2,}(.*)$/.exec(line.trim());
    if (!row) {
      group = line.trim();
      continue;
    }
    const slug = row[1]!;
    if (slug === "cmd" || seen.has(slug)) continue;
    seen.add(slug);
    const rawDescription = row[2]!.trim();
    const isCliDefault = /\(default\)\s*$/.test(rawDescription);
    const description = nonEmpty(rawDescription.replace(/\s*\(default\)\s*$/, ""));
    models.push({ slug, description, group, isCliDefault });
  }
  return models;
}

export function commandCodeModelsFromList(
  listed: ReadonlyArray<CommandCodeListedModel>,
): ReadonlyArray<ServerProviderModel> {
  const cliDefault = listed.find((model) => model.isCliDefault)?.slug;
  return [
    {
      slug: COMMAND_CODE_DEFAULT_MODEL,
      name: cliDefault ? `Default (${cliDefault})` : "Default",
      shortName: "Default",
      isCustom: false,
      isDefault: true,
      capabilities: null,
    },
    ...listed.map((model): ServerProviderModel => {
      const shortName = model.slug.includes("/") ? model.slug.split("/").at(-1) : undefined;
      return {
        slug: model.slug,
        name: model.slug,
        ...(shortName ? { shortName } : {}),
        ...(model.group ? { subProvider: model.group } : {}),
        isCustom: false,
        capabilities: null,
      };
    }),
  ];
}

const StatusJson = Schema.Struct({
  authenticated: Schema.Boolean,
  version: Schema.optionalKey(Schema.String),
});
const decodeStatusJson = Schema.decodeUnknownOption(Schema.fromJsonString(StatusJson));

/** Reads `cmd status --json`. It exits 1 when signed out, so the exit code is not the verdict. */
export function parseCommandCodeStatus(
  output: string,
): { readonly authenticated: boolean; readonly version: string | undefined } | undefined {
  for (const line of output.split(/\r?\n/)) {
    const decoded = decodeStatusJson(line.trim());
    if (Option.isSome(decoded)) {
      return { authenticated: decoded.value.authenticated, version: decoded.value.version };
    }
  }
  return undefined;
}
