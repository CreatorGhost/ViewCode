import * as Effect from "effect/Effect";

import { AgentMessaging } from "../../../agents/AgentMessaging.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { AgentsToolkit } from "./tools.ts";

const make = Effect.gen(function* () {
  const messaging = yield* AgentMessaging;
  const caller = McpInvocationContext.requireMcpCapability("agents").pipe(
    Effect.map((scope) => scope.threadId),
  );
  return AgentsToolkit.of({
    viewcode_list_agents: () =>
      caller.pipe(
        Effect.flatMap((threadId) => messaging.listAgents(threadId)),
        Effect.map((agents) => ({ agents })),
      ),
    viewcode_list_models: () =>
      caller.pipe(
        Effect.andThen(messaging.listModels()),
        Effect.map((providers) => ({ providers })),
      ),
    viewcode_spawn_agent: (input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.spawnAgent(threadId, {
            name: input.name,
            prompt: input.prompt,
            providerId: input.provider_id,
            model: input.model,
            replyExpected: input.reply_expected,
          }),
        ),
      ),
    viewcode_send_message: (input) =>
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
    viewcode_read_transcript: (input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.readTranscript(threadId, {
            agent: input.agent,
            lastMessages: input.last_messages,
          }),
        ),
        Effect.map((transcript) => ({ transcript })),
      ),
    viewcode_search_history: (input) =>
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
    viewcode_configure_agent: (input) =>
      caller.pipe(
        Effect.flatMap((threadId) =>
          messaging.configureAgent(threadId, {
            agent: input.agent,
            providerId: input.provider_id,
            model: input.model,
          }),
        ),
      ),
  });
});

export const AgentsToolkitHandlersLive = AgentsToolkit.toLayer(make);
