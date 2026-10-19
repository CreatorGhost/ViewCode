/**
 * Factory Droid over ACP: `droid exec --output-format acp`.
 *
 * What the CLI does (read from `droid@0.240.0`; config ids and auth method ids
 * also match Synara's Droid support, github.com/Emanuele-web04/synara, MIT):
 *
 * - `initialize` advertises `loadSession`, `sessionCapabilities.resume` and
 *   two auth methods, `device-pairing` (browser) and `factory-api-key`
 *   (reads `FACTORY_API_KEY`). It advertises no `mcpCapabilities`, so only
 *   stdio MCP servers may be sent.
 * - A login stored by running `droid` is used without `authenticate`; with
 *   none, `session/new` fails with "Authentication required" (see
 *   docs/internals/viewcode.md for why ViewCode authenticates up front instead).
 * - In ACP mode `-m`/`-r`/`--auto` are ignored. The session's config options
 *   carry `model`, `reasoning_effort` and `autonomy_level` (`normal`, `spec`,
 *   `auto-low`, `auto-medium`, `auto-high`, capped by the org's maximum).
 * - `droid exec -m <unknown>` prints the built-in and custom model ids on
 *   stderr and exits 1 without starting a session (`parseDroidModelList`).
 *
 * @module DroidAcpSupport
 */
import {
  DROID_DEFAULT_MODEL,
  type DroidSettings,
  type ProviderInteractionMode,
  type ProviderOptionSelection,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";

import {
  collectSessionConfigOptionValues,
  findSessionConfigOption,
} from "@t3tools/provider-acp/server/runtimeModel";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
export const DROID_API_KEY_ENV = "FACTORY_API_KEY";
const DROID_API_KEY_AUTH_METHOD_ID = "factory-api-key";
const DROID_MODEL_CONFIG_ID = "model";
const DROID_REASONING_CONFIG_ID = "reasoning_effort";
const DROID_AUTONOMY_CONFIG_ID = "autonomy_level";
const DROID_SPEC_AUTONOMY = "spec";
/** Autonomy levels from least to most permissive. */
const DROID_AUTONOMY_ORDER = ["normal", "auto-low", "auto-medium", "auto-high"] as const;

export const DROID_NOT_SIGNED_IN_MESSAGE =
  "Droid is not signed in. Run `droid` in a terminal and log in, or set FACTORY_API_KEY in this provider's environment.";

export function droidCommand(settings: Pick<DroidSettings, "binaryPath">): string {
  return settings.binaryPath.trim() || "droid";
}

export function hasDroidApiKey(environment: NodeJS.ProcessEnv): boolean {
  return Boolean(environment[DROID_API_KEY_ENV]?.trim());
}

export interface DroidAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: Pick<DroidSettings, "binaryPath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
}

export const makeDroidAcpRuntime = (
  input: DroidAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { settings, environment, childProcessSpawner, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: {
          command: droidCommand(settings),
          args: ["exec", "--output-format", "acp"],
          cwd: input.cwd,
          env: environment,
        },
        // Droid answers `session/load` with no transcript replay we need.
        resumeMethod: "resume",
        // The key wins over a stored login; device pairing needs a terminal,
        // so without a key Droid's own login is used.
        ...(hasDroidApiKey(environment) ? { authMethodId: DROID_API_KEY_AUTH_METHOD_ID } : {}),
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

/** The autonomy level for a turn, or the most permissive one the org allows below it. */
export function droidAutonomyLevel(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly allowed: ReadonlyArray<string>;
}): string | undefined {
  if (input.interactionMode === "plan") {
    return input.allowed.includes(DROID_SPEC_AUTONOMY) ? DROID_SPEC_AUTONOMY : undefined;
  }
  const wanted =
    input.runtimeMode === "full-access"
      ? "auto-high"
      : input.runtimeMode === "auto"
        ? "auto-medium"
        : input.runtimeMode === "auto-accept-edits"
          ? "auto-low"
          : "normal";
  const ceiling = DROID_AUTONOMY_ORDER.indexOf(wanted);
  return DROID_AUTONOMY_ORDER.slice(0, ceiling + 1)
    .toReversed()
    .find((level) => input.allowed.includes(level));
}

/** Applies a turn's model, reasoning effort and autonomy through Droid's config options. */
export const configureDroidSession = (input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly model: string | undefined;
  readonly options: ReadonlyArray<ProviderOptionSelection> | undefined;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    // The model decides which reasoning efforts exist, so it goes first.
    if (input.model && input.model !== DROID_DEFAULT_MODEL) {
      yield* input.runtime.setConfigOption(DROID_MODEL_CONFIG_ID, input.model);
    }
    const effort = input.options?.find((option) => option.id === "reasoningEffort")?.value;
    if (typeof effort === "string" && effort) {
      yield* input.runtime.setConfigOption(DROID_REASONING_CONFIG_ID, effort);
    }
    const autonomyOption = findSessionConfigOption(
      yield* input.runtime.getConfigOptions,
      DROID_AUTONOMY_CONFIG_ID,
    );
    if (!autonomyOption) return;
    const level = droidAutonomyLevel({
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
      allowed: collectSessionConfigOptionValues(autonomyOption),
    });
    if (level) yield* input.runtime.setConfigOption(DROID_AUTONOMY_CONFIG_ID, level);
  });

/**
 * Reads the model ids `droid exec -m <unknown>` lists:
 *
 *     Available built-in models:
 *       auto, claude-opus-5-5, gpt-6-sol, …
 *
 *     Available custom models:
 *       custom:My-Llama-0 (My Llama)
 */
export function parseDroidModelList(output: string): ReadonlyArray<ServerProviderModel> {
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  const add = (slug: string, name: string) => {
    if (!slug || seen.has(slug)) return;
    seen.add(slug);
    models.push({ slug, name, isCustom: false, capabilities: EMPTY_CAPABILITIES });
  };
  let section: "built-in" | "custom" | undefined;
  for (const line of output.split(/\r?\n/)) {
    const heading = line.match(/^Available (built-in|custom) models:/i);
    if (heading) {
      section = heading[1]!.toLowerCase() === "custom" ? "custom" : "built-in";
      continue;
    }
    if (!/^\s+\S/.test(line)) {
      if (line.trim()) section = undefined;
      continue;
    }
    if (section === "built-in") {
      for (const slug of line.split(",")) add(slug.trim(), slug.trim());
    } else if (section === "custom") {
      const custom = line.trim().match(/^(\S+)(?:\s+\((.+)\))?$/);
      if (custom) add(custom[1]!, custom[2] ?? custom[1]!);
    }
  }
  return models;
}
