import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { AgentMessaging, AgentMessagingError } from "../../../agents/AgentMessaging.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, AgentMessaging];

export const AgentToolError = Schema.Union([McpCapabilityUnavailableError, AgentMessagingError]);

const AgentRef = TrimmedNonEmptyString.annotate({
  description: "The agent's id from viewcode_list_agents, or its exact name.",
});

const ProviderId = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Provider id from viewcode_list_models, e.g. claudeAgent or codex. Defaults to your own provider.",
  }),
);

const ModelId = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Model id from viewcode_list_models. Defaults to the provider's default model (or yours).",
  }),
);

const AgentEntry = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  parentId: Schema.NullOr(Schema.String),
  relation: Schema.Literals(["you", "parent", "child", "sibling", "other"]),
  provider: Schema.String,
  model: Schema.String,
  status: Schema.Literals(["running", "idle", "error", "stopped", "new"]),
  queuedMessages: Schema.Int,
});

const SendResult = Schema.Struct({
  messageId: Schema.String,
  delivery: Schema.Literals(["started", "queued"]).annotate({
    description:
      "started: the receiver was idle and began working. queued: it runs after its current turn.",
  }),
});

const ListAgentsTool = Tool.make("viewcode_list_agents", {
  description:
    "List the ViewCode agents in your agent tree (your root agent and all of its descendants), with their model and status. Use the ids with viewcode_send_message, viewcode_read_transcript and viewcode_configure_agent.",
  success: Schema.Struct({ agents: Schema.Array(AgentEntry) }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListModelsTool = Tool.make("viewcode_list_models", {
  description:
    "List the providers and models available for viewcode_spawn_agent and viewcode_configure_agent. Each provider is a separate subscription. Some providers (Command Code, OpenCode, Cursor) also resell other vendors' models, billed to their own plan. When the user names a model family, use the vendor's own provider (GPT → Codex, Claude → Claude, Grok → Grok) unless they name the reselling provider. Only pick providers with usable: true; if the one the user wants is unusable, tell them its note instead of substituting another provider.",
  success: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        providerId: Schema.String,
        name: Schema.String,
        driver: Schema.String,
        usable: Schema.Boolean,
        note: Schema.optional(Schema.String),
        models: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
      }),
    ),
  }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "List models")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SpawnAgentTool = Tool.make("viewcode_spawn_agent", {
  description:
    "Start a child agent: a separate, full ViewCode agent with its own chat, transcript and model that the user can open, follow and prompt. It works in the same project and checkout as you. Give it a short name and a self-contained prompt. By default its final answer is sent back to you as a message when it finishes, which starts a new turn for you; you do not need to poll. Prefer this over in-session sub-agents when the user asks for agents they can see.",
  parameters: Schema.Struct({
    name: TrimmedNonEmptyString.annotate({
      description: 'Short display name, e.g. "Frontend audit".',
    }),
    prompt: TrimmedNonEmptyString.annotate({
      description: "Complete instructions. The child does not see your conversation.",
    }),
    provider_id: ProviderId,
    model: ModelId,
    reply_expected: Schema.optional(
      Schema.Boolean.annotate({
        description: "Send the child's final answer back to you. Default true.",
      }),
    ),
  }),
  success: Schema.Struct({ agentId: Schema.String, name: Schema.String, ...SendResult.fields }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Spawn child agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const SendMessageTool = Tool.make("viewcode_send_message", {
  description:
    "Send a message to another agent in your tree. An idle agent starts working on it immediately; a busy one gets it after its current turn. Set reply_expected to have its answer routed back to you. To answer a message that expects a reply, pass its response_id.",
  parameters: Schema.Struct({
    to: AgentRef,
    message: TrimmedNonEmptyString,
    reply_expected: Schema.optional(Schema.Boolean),
    response_id: Schema.optional(
      TrimmedNonEmptyString.annotate({
        description:
          "The response_id from a message you are answering. Marks this send as the reply.",
      }),
    ),
  }),
  success: SendResult,
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Send message to agent")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const ReadTranscriptTool = Tool.make("viewcode_read_transcript", {
  description: "Read the recent conversation of another agent in your tree.",
  parameters: Schema.Struct({
    agent: AgentRef,
    last_messages: Schema.optional(
      Schema.Int.annotate({ description: "How many recent messages. Default 12." }),
    ),
  }),
  success: Schema.Struct({ transcript: Schema.String }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Read agent transcript")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SearchHistoryTool = Tool.make("viewcode_search_history", {
  description:
    "Search the full history of this conversation (messages and tool results), or another agent's in your tree. Use it before asking the user about earlier work, and after a handoff to recover details that were condensed: PR numbers, file names, error text, decisions. All query words must appear in a match.",
  parameters: Schema.Struct({
    query: Schema.String.annotate({
      description: 'Words to find, e.g. "PR 1541" or "cordon rollback".',
    }),
    agent: Schema.optional(AgentRef),
    limit: Schema.optional(Schema.Int.annotate({ description: "Maximum matches. Default 8." })),
  }),
  success: Schema.Struct({
    matches: Schema.Array(
      Schema.Struct({ source: Schema.String, createdAt: Schema.String, snippet: Schema.String }),
    ),
  }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Search conversation history")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ConfigureAgentTool = Tool.make("viewcode_configure_agent", {
  description:
    "Switch the model (and optionally provider) another agent uses from its next turn. Switching provider hands its context off automatically.",
  parameters: Schema.Struct({
    agent: AgentRef,
    provider_id: ProviderId,
    model: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ agentId: Schema.String, appliesTo: Schema.Literal("next-turn") }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "Configure agent model")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const AgentsToolkit = Toolkit.make(
  ListAgentsTool,
  ListModelsTool,
  SpawnAgentTool,
  SendMessageTool,
  ReadTranscriptTool,
  SearchHistoryTool,
  ConfigureAgentTool,
);
