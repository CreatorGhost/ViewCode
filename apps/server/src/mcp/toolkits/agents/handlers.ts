import * as Effect from "effect/Effect";

import { AgentMessaging } from "../../../agents/AgentMessagingV2.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkit } from "./tools.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";

const make = Effect.gen(function* () {
  const messaging = yield* AgentMessaging;
  const caller = McpInvocationContext.requireMcpCapability("agents").pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, "Agent messaging")),
    Effect.map((scope) => scope.thread.threadId),
  );
  return {
    viewcode_list_agents: McpToolAccess.readsAsCaller(() =>
      caller.pipe(
        Effect.flatMap((threadId) => messaging.listAgents(threadId)),
        Effect.map((agents) => ({ agents })),
      ),
    ),
    viewcode_list_models: McpToolAccess.readsAsCaller(() =>
      caller.pipe(
        Effect.andThen(messaging.listModels()),
        Effect.map((providers) => ({ providers })),
      ),
    ),
    viewcode_spawn_agent: McpToolAccess.actsAsCaller((input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.spawnAgent(threadId, {
            name: input.name,
            prompt: input.prompt,
            providerId: input.provider_id,
            model: input.model,
            effort: input.effort,
            fastMode: input.fast_mode,
            replyExpected: input.reply_expected,
            task: input.task,
          }),
        ),
      ),
    ),
    viewcode_send_message: McpToolAccess.actsAsCaller((input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.sendMessage(threadId, {
            to: input.to,
            message: input.message,
            replyExpected: input.reply_expected,
            responseId: input.response_id,
          }),
        ),
      ),
    ),
    viewcode_read_transcript: McpToolAccess.readsAsCaller((input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.readTranscript(threadId, {
            agent: input.agent,
            lastMessages: input.last_messages,
          }),
        ),
        Effect.map((transcript) => ({ transcript })),
      ),
    ),
    viewcode_search_history: McpToolAccess.readsAsCaller((input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.searchHistory(threadId, {
            query: input.query,
            agent: input.agent,
            limit: input.limit,
          }),
        ),
        Effect.map((matches) => ({ matches })),
      ),
    ),
    viewcode_configure_agent: McpToolAccess.actsAsCaller((input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.configureAgent(threadId, {
            agent: input.agent,
            providerId: input.provider_id,
            model: input.model,
            effort: input.effort,
            fastMode: input.fast_mode,
          }),
        ),
      ),
    ),
  } satisfies McpToolAccess.Handlers<typeof AgentsToolkit.tools>;
});

export const layer = McpToolAccess.toLayer(AgentsToolkit, make);
