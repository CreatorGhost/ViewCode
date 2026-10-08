import * as Schema from "effect/Schema";

import { NonNegativeInt } from "./baseSchemas.ts";

/**
 * ViewCode read aloud: the natural voice (Kokoro-82M) in three sizes. Small is
 * the q8 model, medium fp16 and large fp32. The environment downloads a tier
 * once from ViewCode's GitHub release and serves it to its clients, which run
 * the voice themselves.
 */
export const VoiceModelTier = Schema.Literals(["small", "medium", "large"]);
export type VoiceModelTier = typeof VoiceModelTier.Type;
export const VOICE_MODEL_TIERS: ReadonlyArray<VoiceModelTier> = ["small", "medium", "large"];
export const DEFAULT_VOICE_MODEL_TIER: VoiceModelTier = "small";

export const VoiceModelTierState = Schema.Struct({
  tier: VoiceModelTier,
  phase: Schema.Literals(["absent", "downloading", "ready", "failed"]),
  downloadedBytes: NonNegativeInt,
  /** Known once the manifest is read; null before the first download. */
  totalBytes: Schema.NullOr(NonNegativeInt),
  /** Why the last download failed, in words for the user. */
  message: Schema.NullOr(Schema.String),
});
export type VoiceModelTierState = typeof VoiceModelTierState.Type;

export const VoiceModelsState = Schema.Struct({
  tiers: Schema.Array(VoiceModelTierState),
});
export type VoiceModelsState = typeof VoiceModelsState.Type;

export const VoiceModelTierInput = Schema.Struct({ tier: VoiceModelTier });
export type VoiceModelTierInput = typeof VoiceModelTierInput.Type;

export class VoiceModelError extends Schema.TaggedError<VoiceModelError>()("VoiceModelError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
