/**
 * Pi coding agent (`pi --mode rpc`) protocol: launch arguments, discovery
 * parsing, and the mapping from Pi's session events to canonical runtime
 * events. Pure, so the adapter only owns the process and stamping. The model
 * slug, thinking-level and command parsing follow upstream T3 Code's
 * `packages/provider-pi`.
 *
 * What Pi does (read from `@earendil-works/pi-coding-agent@1.2.0`, docs
 * `rpc.md`, `rpc-commands.md`, `json.md`, `rpc-extension-ui.md`):
 *
 * - Commands go to stdin as `{"id","type",...}` JSON lines; `response`
 *   records repeat the id. Every other stdout record is a session event.
 * - `prompt` is answered once accepted (`disposition`: `started`, `queued`
 *   or `handled`); work streams as events and only `agent_settled` means Pi
 *   will not continue on its own (retries, compaction, queued steers).
 * - Assistant text and thinking stream as `message_update` deltas; a failed
 *   model call ends its assistant message with `stopReason: "error"` and an
 *   `errorMessage`. Tools report `tool_execution_start` / `_end`.
 * - Extensions raise dialogs as `extension_ui_request` (`confirm`, `select`,
 *   `input`, `editor`) and wait for an `extension_ui_response` with that id.
 * - `--session <file>` reopens a session; `get_state` names the file.
 *   `get_available_models` lists models with credentials, `provider/id`.
 * - Since 0.99 Pi has built-in MCP, and an extension can add a server for
 *   the session with `pi.registerMcpServer` (`piExtension.ts`).
 *
 * @module piRpc
 */
import {
  type CanonicalItemType,
  type ModelCapabilities,
  type ProviderOptionChoice,
  type ProviderRuntimeEvent,
  RuntimeItemId,
  type ServerProviderModel,
  type ServerProviderSkill,
  type ServerProviderSlashCommand,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";

/** Pi 0.99 added built-in MCP and `registerMcpServer`, which ViewCode's tools need. */
export const MINIMUM_PI_VERSION = "0.99.0";

export type PiRecord = Record<string, unknown>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A canonical event before the adapter stamps ids, time, thread and turn. */
export type PiEventDraft = DistributiveOmit<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt" | "turnId"
>;

function isRecord(value: unknown): value is PiRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function piField(input: unknown, key: string): unknown {
  return isRecord(input) ? input[key] : undefined;
}

export function piString(input: unknown, key: string): string | undefined {
  const value = piField(input, key);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function piNumber(input: unknown, key: string): number | undefined {
  const value = piField(input, key);
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 3)}...`;
}

/** `provider/model-id`; null for a slug without a usable separator. */
export function parsePiModelSlug(slug: string): { provider: string; modelId: string } | null {
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { provider: slug.slice(0, separator), modelId: slug.slice(separator + 1) };
}

// ── Thinking levels ─────────────────────────────────────────────────

/** Pi's ladder; Extra High and Max exist only where a model's `thinkingLevelMap` names them. */
const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const PI_THINKING_LABELS: Record<(typeof PI_THINKING_LEVELS)[number], string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};
/** The model option id the composer stores a thinking level under. */
export const PI_THINKING_OPTION_ID = "thinking";
export const EMPTY_PI_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

export function piThinkingCapabilities(model: unknown, currentLevel?: string): ModelCapabilities {
  if (piField(model, "reasoning") !== true) return EMPTY_PI_CAPABILITIES;
  const map = piField(model, "thinkingLevelMap");
  const levels = PI_THINKING_LEVELS.filter((level) => {
    const mapped = isRecord(map) ? map[level] : undefined;
    if (mapped === null) return false;
    return level === "xhigh" || level === "max" ? mapped !== undefined : true;
  });
  return createModelCapabilities({
    optionDescriptors: [
      {
        id: PI_THINKING_OPTION_ID,
        label: "Thinking",
        type: "select",
        options: levels.map((level): ProviderOptionChoice => ({
          id: level,
          label: PI_THINKING_LABELS[level],
          ...(level === currentLevel ? { isDefault: true } : {}),
        })),
      },
    ],
  });
}

// ── Discovery ───────────────────────────────────────────────────────

/** Models from `get_available_models`, with the session's thinking level as default. */
export function parsePiModels(modelsData: unknown, stateData: unknown): Array<ServerProviderModel> {
  const models = piField(modelsData, "models");
  if (!Array.isArray(models)) return [];
  const active = piField(stateData, "model");
  const activeSlug = `${piString(active, "provider") ?? ""}/${piString(active, "id") ?? ""}`;
  const seen = new Set<string>();
  return models.flatMap((model): Array<ServerProviderModel> => {
    const provider = piString(model, "provider");
    const id = piString(model, "id");
    if (!provider || !id || seen.has(`${provider}/${id}`)) return [];
    const slug = `${provider}/${id}`;
    seen.add(slug);
    return [
      {
        slug,
        name: piString(model, "name") ?? slug,
        subProvider: provider,
        isCustom: false,
        capabilities: piThinkingCapabilities(
          model,
          slug === activeSlug ? piString(stateData, "thinkingLevel") : undefined,
        ),
      },
    ];
  });
}

/** RPC `get_commands` leaves out TUI builtins; ViewCode maps `/compact` to RPC `compact`. */
export const PI_COMPACT_SLASH_COMMAND: ServerProviderSlashCommand = {
  name: "compact",
  description: "Summarize the conversation and reduce context usage",
  input: { hint: "Optional instructions" },
};

/** `/compact [instructions]`, or null for any other text. */
export function parsePiCompactCommand(text: string): { customInstructions?: string } | null {
  const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!match) return null;
  const customInstructions = match[1]?.trim();
  return customInstructions ? { customInstructions } : {};
}

/** Slash commands and skills from `get_commands`. */
export function parsePiCommands(data: unknown): {
  readonly slashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly skills: ReadonlyArray<ServerProviderSkill>;
} {
  const commands = piField(data, "commands");
  const slashCommands: Array<ServerProviderSlashCommand> = [PI_COMPACT_SLASH_COMMAND];
  const skills: Array<ServerProviderSkill> = [];
  for (const command of Array.isArray(commands) ? commands : []) {
    const name = piString(command, "name");
    if (!name || name === "compact") continue;
    const description = piString(command, "description");
    if (piString(command, "source") === "skill") {
      const skillName = name.startsWith("skill:") ? name.slice("skill:".length) : name;
      if (!skillName) continue;
      const sourceInfo = piField(command, "sourceInfo");
      skills.push({
        name: skillName,
        path: piString(sourceInfo, "path") ?? `pi:skill:${skillName}`,
        enabled: true,
        ...(description ? { description } : {}),
      });
      continue;
    }
    slashCommands.push({ name, ...(description ? { description } : {}) });
  }
  return { slashCommands, skills };
}

// ── Turn events ─────────────────────────────────────────────────────

export function classifyPiTool(toolName: string): CanonicalItemType {
  if (toolName.startsWith("mcp__")) return "mcp_tool_call";
  if (toolName === "bash") return "command_execution";
  if (toolName === "edit" || toolName === "write") return "file_change";
  return "dynamic_tool_call";
}

function toolTitle(itemType: CanonicalItemType, toolName: string): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    default:
      return toolName;
  }
}

function toolDetail(toolName: string, args: unknown): string | undefined {
  for (const key of ["command", "path", "file_path", "pattern", "query", "url"]) {
    const value = piString(args, key);
    if (value) return truncate(`${toolName}: ${value}`, 400);
  }
  return toolName;
}

/** Text of a tool result's or message's content blocks. */
export function piContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      piField(block, "type") === "text" && typeof piField(block, "text") === "string"
        ? [piField(block, "text") as string]
        : [],
    )
    .join("\n");
}

interface OpenText {
  readonly itemId: RuntimeItemId;
  text: string;
}

interface OpenTool {
  readonly itemId: RuntimeItemId;
  readonly itemType: CanonicalItemType;
  readonly toolName: string;
  readonly title: string;
  readonly detail: string | undefined;
  readonly args: unknown;
}

export interface PiTurnMapper {
  readonly accept: (record: PiRecord) => ReadonlyArray<PiEventDraft>;
  /** Drafts that close the turn when Pi reports `agent_settled`. */
  readonly settle: (aborted: boolean) => ReadonlyArray<PiEventDraft>;
}

/**
 * Stateful mapper for one turn. `itemIdPrefix` must be unique per turn;
 * `contextWindow` is the active model's, for the context meter.
 */
export function makePiTurnMapper(input: {
  readonly itemIdPrefix: string;
  readonly contextWindow?: number | undefined;
}): PiTurnMapper {
  let segment = 0;
  let assistant: OpenText | undefined;
  let reasoning: OpenText | undefined;
  const tools = new Map<string, OpenTool>();
  /** The last assistant message's failure; a later success (a retry) clears it. */
  let lastError: string | undefined;
  let stopReason: string | undefined;

  const nextItemId = (kind: string) => {
    segment += 1;
    return RuntimeItemId.make(`${input.itemIdPrefix}:${kind}:${segment}`);
  };

  const closeText = (kind: "assistant" | "reasoning"): Array<PiEventDraft> => {
    const open = kind === "assistant" ? assistant : reasoning;
    if (kind === "assistant") assistant = undefined;
    else reasoning = undefined;
    if (!open) return [];
    const detail = kind === "assistant" ? open.text.trim() : "";
    return [
      {
        type: "item.completed",
        itemId: open.itemId,
        payload: {
          itemType: kind === "assistant" ? "assistant_message" : "reasoning",
          status: "completed",
          title: kind === "assistant" ? "Assistant message" : "Reasoning",
          ...(detail ? { detail: truncate(detail, 2000) } : {}),
        },
      },
    ];
  };

  const appendText = (kind: "assistant" | "reasoning", delta: string): Array<PiEventDraft> => {
    if (!delta) return [];
    const drafts: Array<PiEventDraft> = kind === "assistant" ? closeText("reasoning") : [];
    let open = kind === "assistant" ? assistant : reasoning;
    if (!open) {
      open = { itemId: nextItemId(kind), text: "" };
      if (kind === "assistant") assistant = open;
      else reasoning = open;
      drafts.push({
        type: "item.started",
        itemId: open.itemId,
        payload: {
          itemType: kind === "assistant" ? "assistant_message" : "reasoning",
          status: "inProgress",
          ...(kind === "reasoning" ? { title: "Reasoning" } : {}),
        },
      });
    }
    open.text += delta;
    drafts.push({
      type: "content.delta",
      itemId: open.itemId,
      payload: {
        streamKind: kind === "assistant" ? "assistant_text" : "reasoning_text",
        delta,
      },
    });
    return drafts;
  };

  const usageDraft = (usage: unknown): Array<PiEventDraft> => {
    const input_ = piNumber(usage, "input") ?? 0;
    const cacheRead = piNumber(usage, "cacheRead") ?? 0;
    const cacheWrite = piNumber(usage, "cacheWrite") ?? 0;
    const output = piNumber(usage, "output") ?? 0;
    // Everything the request sent plus what it produced is in context now.
    const usedTokens = Math.floor(input_ + cacheRead + cacheWrite + output);
    if (usedTokens === 0) return [];
    return [
      {
        type: "thread.token-usage.updated",
        payload: {
          usage: {
            usedTokens,
            lastUsedTokens: usedTokens,
            lastInputTokens: Math.floor(input_ + cacheRead + cacheWrite),
            lastOutputTokens: Math.floor(output),
            ...(cacheRead > 0 ? { lastCachedInputTokens: Math.floor(cacheRead) } : {}),
            ...(input.contextWindow ? { maxTokens: Math.floor(input.contextWindow) } : {}),
          },
        },
      },
    ];
  };

  const settleTool = (
    toolCallId: string,
    status: "completed" | "failed",
    output: string,
  ): Array<PiEventDraft> => {
    const tool = tools.get(toolCallId);
    if (!tool) return [];
    tools.delete(toolCallId);
    const drafts: Array<PiEventDraft> = [];
    const streamKind =
      tool.itemType === "command_execution"
        ? "command_output"
        : tool.itemType === "file_change"
          ? "file_change_output"
          : undefined;
    if (streamKind && output) {
      drafts.push({
        type: "content.delta",
        itemId: tool.itemId,
        payload: { streamKind, delta: output },
      });
    }
    const detail = status === "completed" ? tool.detail : output.trim() || tool.detail;
    drafts.push({
      type: "item.completed",
      itemId: tool.itemId,
      payload: {
        itemType: tool.itemType,
        status,
        title: tool.title,
        ...(detail ? { detail: truncate(detail, 2000) } : {}),
        data: { toolName: tool.toolName, input: tool.args, result: output },
      },
    });
    return drafts;
  };

  const accept = (record: PiRecord): ReadonlyArray<PiEventDraft> => {
    switch (record.type) {
      case "message_update": {
        const event = piField(record, "assistantMessageEvent");
        const delta = piField(event, "delta");
        if (typeof delta !== "string") return [];
        const kind = piField(event, "type");
        return kind === "text_delta"
          ? appendText("assistant", delta)
          : kind === "thinking_delta"
            ? appendText("reasoning", delta)
            : [];
      }
      case "message_end": {
        const message = piField(record, "message");
        if (piField(message, "role") !== "assistant") return [];
        const failed = piField(message, "stopReason") === "error";
        lastError = failed
          ? (piString(message, "errorMessage") ?? "The model request failed.")
          : undefined;
        stopReason = piString(message, "stopReason");
        return [
          ...closeText("reasoning"),
          ...closeText("assistant"),
          ...usageDraft(piField(message, "usage")),
        ];
      }
      case "tool_execution_start": {
        const toolCallId = piString(record, "toolCallId");
        const toolName = piString(record, "toolName") ?? "tool";
        if (!toolCallId) return [];
        const itemType = classifyPiTool(toolName);
        const args = piField(record, "args");
        const tool: OpenTool = {
          itemId: RuntimeItemId.make(`${input.itemIdPrefix}:tool:${toolCallId}`),
          itemType,
          toolName,
          title: toolTitle(itemType, toolName),
          detail: toolDetail(toolName, args),
          args,
        };
        tools.set(toolCallId, tool);
        return [
          ...closeText("reasoning"),
          ...closeText("assistant"),
          {
            type: "item.started",
            itemId: tool.itemId,
            payload: {
              itemType,
              status: "inProgress",
              title: tool.title,
              ...(tool.detail ? { detail: tool.detail } : {}),
              data: { toolName, input: args },
            },
          },
        ];
      }
      case "tool_execution_end": {
        const toolCallId = piString(record, "toolCallId");
        if (!toolCallId) return [];
        const output = piContentText(piField(piField(record, "result"), "content"));
        return settleTool(
          toolCallId,
          piField(record, "isError") === true ? "failed" : "completed",
          output,
        );
      }
      case "auto_retry_start": {
        const reason = piString(record, "errorMessage");
        return [
          {
            type: "runtime.warning",
            payload: {
              message: `Pi is retrying the model request (attempt ${piNumber(record, "attempt") ?? 1})${
                reason ? `: ${truncate(reason, 300)}` : "."
              }`,
            },
          },
        ];
      }
      case "compaction_start":
        return [
          {
            type: "item.started",
            itemId: RuntimeItemId.make(`${input.itemIdPrefix}:compaction`),
            payload: { itemType: "context_compaction", status: "inProgress", title: "Compacting" },
          },
        ];
      case "compaction_end": {
        const failure = piString(record, "errorMessage");
        return [
          {
            type: "item.completed",
            itemId: RuntimeItemId.make(`${input.itemIdPrefix}:compaction`),
            payload: {
              itemType: "context_compaction",
              status: failure || piField(record, "aborted") === true ? "failed" : "completed",
              title: "Context compacted",
              ...(failure ? { detail: truncate(failure, 2000) } : {}),
            },
          },
        ];
      }
      case "extension_error": {
        const error = piString(record, "error");
        return error
          ? [
              {
                type: "runtime.warning",
                payload: { message: `Pi extension error: ${truncate(error, 500)}` },
              },
            ]
          : [];
      }
      default:
        return [];
    }
  };

  const settle = (aborted: boolean): ReadonlyArray<PiEventDraft> => {
    const drafts: Array<PiEventDraft> = [...closeText("reasoning"), ...closeText("assistant")];
    for (const toolCallId of tools.keys()) {
      drafts.push(
        ...settleTool(toolCallId, "failed", aborted ? "Stopped before the tool finished." : ""),
      );
    }
    if (aborted) {
      drafts.push({
        type: "turn.completed",
        payload: { state: "cancelled", stopReason: "aborted" },
      });
    } else if (lastError) {
      const message = truncate(lastError, 2000);
      drafts.push(
        { type: "runtime.error", payload: { message, class: "provider_error" } },
        { type: "turn.completed", payload: { state: "failed", errorMessage: message } },
      );
    } else {
      drafts.push({
        type: "turn.completed",
        payload: { state: "completed", stopReason: stopReason ?? null },
      });
    }
    return drafts;
  };

  return { accept, settle };
}
