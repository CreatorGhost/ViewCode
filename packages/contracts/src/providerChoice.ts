/**
 * ViewCode: which provider CLIs an environment could run, found by a
 * filesystem lookup only. Listing them never starts a provider CLI, which
 * endpoint security on managed machines would flag.
 */
import * as Schema from "effect/Schema";

import { ProviderDriverKind } from "./providerInstance.ts";

export const DetectedProvider = Schema.Struct({
  driver: ProviderDriverKind,
  installed: Schema.Boolean,
  /** Where the executable was found, or null when it was not. */
  path: Schema.NullOr(Schema.String),
});
export type DetectedProvider = typeof DetectedProvider.Type;

export const DetectProvidersResult = Schema.Struct({
  providers: Schema.Array(DetectedProvider),
});
export type DetectProvidersResult = typeof DetectProvidersResult.Type;
