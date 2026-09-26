/**
 * ViewCode: choosing which providers an environment may run.
 *
 * A fresh environment probes no provider until the user picks some
 * (`ServerSettings.providersChosenAt`). Detection is a filesystem lookup only,
 * so listing the choices never starts a provider CLI.
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

export const ChooseProvidersInput = Schema.Struct({
  /** Built-in drivers to enable; every other built-in driver is disabled. */
  enabled: Schema.Array(ProviderDriverKind),
});
export type ChooseProvidersInput = typeof ChooseProvidersInput.Type;
