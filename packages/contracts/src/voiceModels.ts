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

/**
 * A model the environment downloads and serves: a read-aloud tier, or
 * `dictation`, the speech-to-text model (Moonshine base) that dictation in the
 * web and desktop composer runs. Carried in the `tier` field of the inputs so
 * servers from before dictation keep reading read-aloud requests.
 */
export const VoiceModelKey = Schema.Literals(["small", "medium", "large", "dictation"]);
export type VoiceModelKey = typeof VoiceModelKey.Type;
export const DICTATION_MODEL_KEY = "dictation" satisfies VoiceModelKey;

/** One model's download. */
export const VoiceModelDownloadState = Schema.Struct({
  phase: Schema.Literals(["absent", "downloading", "ready", "failed"]),
  downloadedBytes: NonNegativeInt,
  /** Known once the manifest is read; null before the first download. */
  totalBytes: Schema.NullOr(NonNegativeInt),
  /** Why the last download failed, in words for the user. */
  message: Schema.NullOr(Schema.String),
});
export type VoiceModelDownloadState = typeof VoiceModelDownloadState.Type;

export const VoiceModelTierState = Schema.Struct({
  tier: VoiceModelTier,
  ...VoiceModelDownloadState.fields,
});
export type VoiceModelTierState = typeof VoiceModelTierState.Type;

export const VoiceModelsState = Schema.Struct({
  tiers: Schema.Array(VoiceModelTierState),
  /** Missing from servers that cannot serve dictation. */
  dictation: Schema.optionalKey(VoiceModelDownloadState),
});
export type VoiceModelsState = typeof VoiceModelsState.Type;

export const VoiceModelTierInput = Schema.Struct({ tier: VoiceModelKey });
export type VoiceModelTierInput = typeof VoiceModelTierInput.Type;

/** Which downloads to delete: every read-aloud tier (the default), or the dictation model. */
export const VoiceModelRemoveInput = Schema.Struct({
  kind: Schema.optionalKey(Schema.Literals(["read-aloud", "dictation"])),
});
export type VoiceModelRemoveInput = typeof VoiceModelRemoveInput.Type;

export class VoiceModelError extends Schema.TaggedError<VoiceModelError>()("VoiceModelError", {
  detail: Schema.String,
}) {
  override get message(): string {
    return this.detail;
  }
}
