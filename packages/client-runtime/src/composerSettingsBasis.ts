import {
  ModelSelection,
  ProviderInteractionMode,
  RuntimeMode,
  type ModelSelection as ModelSelectionType,
  type ProviderInteractionMode as ProviderInteractionModeType,
  type RuntimeMode as RuntimeModeType,
} from "@t3tools/contracts";
import * as Equal from "effect/Equal";
import * as Schema from "effect/Schema";

/** The thread settings a composer can change locally before it sends. */
export interface ComposerThreadSettings {
  readonly modelSelection: ModelSelectionType;
  readonly runtimeMode: RuntimeModeType;
  readonly interactionMode: ProviderInteractionModeType;
}

export type ComposerSettingKey = keyof ComposerThreadSettings;

/**
 * Per setting, the thread's server value a composer's local pick was made
 * against. `null` means the pick was written where the server value was not at
 * hand (a picker, a restored queued message); it binds to the first server
 * value the composer sees. A pick with no entry, as drafts from older builds
 * have, follows the server.
 */
export const ComposerSettingsBasis = Schema.Struct({
  modelSelection: Schema.optionalKey(Schema.NullOr(ModelSelection)),
  runtimeMode: Schema.optionalKey(Schema.NullOr(RuntimeMode)),
  interactionMode: Schema.optionalKey(Schema.NullOr(ProviderInteractionMode)),
});
export type ComposerSettingsBasis = typeof ComposerSettingsBasis.Type;

/** Marks `keys` as freshly picked; the composer binds them to the server value it sees next. */
export function markComposerPicks(
  basis: ComposerSettingsBasis | undefined,
  keys: ReadonlyArray<ComposerSettingKey>,
): ComposerSettingsBasis {
  const next: { -readonly [K in ComposerSettingKey]?: ComposerSettingsBasis[K] } = { ...basis };
  for (const key of keys) next[key] = null;
  return next;
}

interface PickDecision<T> {
  readonly drop: boolean;
  readonly basis: T | undefined;
  readonly changed: boolean;
}

function decidePick<K extends ComposerSettingKey>(
  key: K,
  input: Parameters<typeof reconcileComposerPicks>[0],
): PickDecision<ComposerThreadSettings[K]> {
  const current = input.basis?.[key];
  const server = input.server[key];
  if (!input.picked.includes(key)) {
    // A basis without a pick says nothing; let it go.
    return { drop: false, basis: undefined, changed: current !== undefined };
  }
  if (current === null) return { drop: false, basis: server, changed: true };
  if (current !== undefined && Equal.equals(current, server)) {
    return { drop: false, basis: server, changed: false };
  }
  return { drop: true, basis: undefined, changed: true };
}

/**
 * Squares a thread composer's local picks with the thread's server settings,
 * which are what the next message uses unless the composer says otherwise. A
 * pick is an unsent intent made against one server value: once the server
 * holds another (changed from another client, by the server or an agent, or by
 * this composer's own send), the pick is dropped and the composer shows the
 * server's. A pick made after that change was based on the new value and stays.
 *
 * `picked` lists the settings the draft overrides. Returns the keys to drop and
 * the basis to store, or null when nothing changes.
 */
export function reconcileComposerPicks(input: {
  readonly picked: ReadonlyArray<ComposerSettingKey>;
  readonly basis: ComposerSettingsBasis | undefined;
  readonly server: ComposerThreadSettings;
}): {
  readonly drop: ReadonlyArray<ComposerSettingKey>;
  readonly basis: ComposerSettingsBasis | undefined;
} | null {
  const modelSelection = decidePick("modelSelection", input);
  const runtimeMode = decidePick("runtimeMode", input);
  const interactionMode = decidePick("interactionMode", input);
  if (!modelSelection.changed && !runtimeMode.changed && !interactionMode.changed) return null;
  const basis: ComposerSettingsBasis = {
    ...(modelSelection.basis !== undefined ? { modelSelection: modelSelection.basis } : {}),
    ...(runtimeMode.basis !== undefined ? { runtimeMode: runtimeMode.basis } : {}),
    ...(interactionMode.basis !== undefined ? { interactionMode: interactionMode.basis } : {}),
  };
  return {
    drop: [
      ...(modelSelection.drop ? (["modelSelection"] as const) : []),
      ...(runtimeMode.drop ? (["runtimeMode"] as const) : []),
      ...(interactionMode.drop ? (["interactionMode"] as const) : []),
    ],
    basis: Object.keys(basis).length > 0 ? basis : undefined,
  };
}
