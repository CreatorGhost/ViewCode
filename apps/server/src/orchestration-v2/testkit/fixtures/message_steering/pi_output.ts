import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertAssistantTextIncludes,
  assertBaseProjection,
  assertRuntimeRequestCounts,
  assertSemanticProjectionIntegrity,
  assertTurnItemTypes,
  assertUserMessageInputIntents,
  assertUserMessagesInclude,
  assertVisibleTurnItemsMirrorLocalTurnItems,
  MESSAGE_STEERING_INITIAL_PROMPT,
  MESSAGE_STEERING_STEER_PROMPT,
  projectionFor,
} from "../shared.ts";

function frameField(frame: unknown, key: string): unknown {
  return typeof frame === "object" && frame !== null ? Reflect.get(frame, key) : undefined;
}

/**
 * Pi steers through `prompt` with `streamingBehavior: "steer"`, which Pi
 * queues into the running agent loop. The steer lands in the same provider
 * turn: no interrupt, no second turn, one settled run.
 */
export function assertPiMessageSteeringOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  const outbound = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" ? [entry.frame] : [],
  );
  const prompts = outbound.filter((frame) => frameField(frame, "type") === "prompt");
  assert.lengthOf(prompts, 2);
  const initialPrompt = frameField(prompts[0], "message");
  // ViewCode adds its context to the initial turn; steering reuses that turn's context.
  assert.isTrue(
    typeof initialPrompt === "string" &&
      (initialPrompt === MESSAGE_STEERING_INITIAL_PROMPT ||
        initialPrompt.endsWith(`\n\n${MESSAGE_STEERING_INITIAL_PROMPT}`)),
  );
  assert.deepEqual(
    prompts.map((frame) => frameField(frame, "streamingBehavior")),
    ["steer", "steer"],
  );
  assert.equal(frameField(prompts[1], "message"), MESSAGE_STEERING_STEER_PROMPT);
  assert.isFalse(
    outbound.some((frame) => frameField(frame, "type") === "abort"),
    "steering must not abort the running Pi turn",
  );

  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertVisibleTurnItemsMirrorLocalTurnItems(projection);
  assertTurnItemTypes(projection, ["user_message", "assistant_message"]);
  assertRuntimeRequestCounts(projection, { total: 0 });
  assertUserMessagesInclude(projection, [
    MESSAGE_STEERING_INITIAL_PROMPT,
    MESSAGE_STEERING_STEER_PROMPT,
  ]);
  assertUserMessageInputIntents(projection, ["turn_start", "steer"]);
  assertAssistantTextIncludes(projection, "steering fixture observed");
  assert.lengthOf(projection.providerTurns, 1, "active steering must not start a provider turn");
  assert.equal(projection.providerTurns[0]?.status, "completed");
}
