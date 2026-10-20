import * as Schema from "effect/Schema";

import { ThreadId } from "./baseSchemas.ts";

/**
 * Opens the environment's latest RockBot chat, creating one on first use. `newChat`
 * starts a fresh chat instead, reusing one the user has not written in yet.
 */
export const RockBotOpenInput = Schema.Struct({
  creationSource: Schema.optional(Schema.Literals(["web", "mobile"])),
  newChat: Schema.optional(Schema.Boolean),
});
export type RockBotOpenInput = typeof RockBotOpenInput.Type;

export const RockBotOpenResult = Schema.Struct({ threadId: ThreadId });
export type RockBotOpenResult = typeof RockBotOpenResult.Type;
