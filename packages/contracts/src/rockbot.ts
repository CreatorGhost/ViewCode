import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/** Opens the environment's one RockBot thread, creating it on first use. */
export const RockBotOpenInput = Schema.Struct({
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
});
export type RockBotOpenInput = typeof RockBotOpenInput.Type;

export const RockBotOpenResult = Schema.Struct({ threadId: ThreadId });
export type RockBotOpenResult = typeof RockBotOpenResult.Type;
