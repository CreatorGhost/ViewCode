import { McpCapabilityUnavailableError, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Tool from "effect/unstable/ai/Tool";
import * as Toolkit from "effect/unstable/ai/Toolkit";

import { AgentMessaging, AgentMessagingError } from "../../../agents/AgentMessaging.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [McpInvocationContext.McpInvocationContext, AgentMessaging];

export const AgentToolError = Schema.Union([McpCapabilityUnavailableError, AgentMessagingError]);

const AgentRef = TrimmedNonEmptyString.annotate({
  description: "The agent's id from list_agents, or its exact name.",
});

const ProviderId = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description:
      "Provider id from list_models, e.g. claudeAgent or codex. Defaults to your own provider.",
  }),
);

const ModelId = Schema.optional(
  TrimmedNonEmptyString.annotate({
    description: "Model id from list_models. Defaults to the provider's default model (or yours).",
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

const ListAgentsTool = Tool.make("list_agents", {
  description:
    "List the ViewCode agents in your agent tree (your root agent and all of its descendants), with their model and status. Use the ids with send_message, read_transcript and configure_agent.",
  success: Schema.Struct({ agents: Schema.Array(AgentEntry) }),
  failure: AgentToolError,
  dependencies,
})
  .annotate(Tool.Title, "List agents")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const ListModelsTool = Tool.make("list_models", {
  description:
    "List the providers and models available for spawn_agent and configure_agent. Pick the model that fits the task, e.g. a fast model for search, a strong one for review.",
  success: Schema.Struct({
    providers: Schema.Array(
      Schema.Struct({
        providerId: Schema.String,
        name: Schema.String,
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

const SpawnAgentTool = Tool.make("spawn_agent", {
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

const SendMessageTool = Tool.make("send_message", {
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

const ReadTranscriptTool = Tool.make("read_transcript", {
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

const ConfigureAgentTool = Tool.make("configure_agent", {
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
  ConfigureAgentTool,
);
