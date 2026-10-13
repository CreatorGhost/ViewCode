/**
 * Devin CLI over ACP: `devin acp`.
 *
 * What the CLI does (read from `devin 3000.6.11`; Synara's Devin support,
 * github.com/Emanuele-web04/synara, MIT, informed the model parsing):
 *
 * - `initialize` advertises `loadSession` (no `resume`), `mcpCapabilities`
 *   with `http: false`, and only an interactive `devin-browser` auth method.
 *   ACP-supplied stdio MCP servers are started.
 * - The ACP server uses the login `devin auth login` stored, or
 *   `WINDSURF_API_KEY`, without `authenticate`; with neither, `session/new`
 *   still succeeds and prompts fail.
 * - The session's `mode` config option is `accept-edits` (Code), `ask`,
 *   `plan` or `bypass`; `model` lists the account's models. `--model` takes the
 *   same fuzzy names as `/model`, so a family slug from `devin models list`
 *   works at launch.
 * - `/compact` is an advertised slash command.
 * - `devin models list --format json` needs a login ("Not logged in" and exit
 *   1 otherwise), so it doubles as the health check's sign-in probe.
 *
 * @module DevinAcpSupport
 */
import {
  DEVIN_DEFAULT_MODEL,
  type DevinSettings,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import { collectSessionConfigOptionValues, findSessionConfigOption } from "./AcpRuntimeModel.ts";
import * as AcpSessionRuntime from "./AcpSessionRuntime.ts";

const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });
const DEVIN_MODE_CONFIG_ID = "mode";
const DEVIN_MODEL_CONFIG_ID = "model";
export const DEVIN_API_KEY_ENV = "WINDSURF_API_KEY";

export const DEVIN_NOT_SIGNED_IN_MESSAGE =
  "Devin is not signed in. Run `devin auth login` in a terminal, or set WINDSURF_API_KEY in this provider's environment.";

export function devinCommand(settings: Pick<DevinSettings, "binaryPath">): string {
  return settings.binaryPath.trim() || "devin";
}

/** True for a model a user picked, as opposed to "whatever Devin is set to". */
export function isExplicitDevinModel(model: string | undefined): model is string {
  return model !== undefined && model.trim() !== "" && model !== DEVIN_DEFAULT_MODEL;
}

export interface DevinAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "authenticateOnDemand" | "spawn"
> {
  readonly settings: Pick<DevinSettings, "binaryPath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  /** Model for new sessions; mid-session changes go through the `model` config option. */
  readonly model?: string | undefined;
}

export const makeDevinAcpRuntime = (
  input: DevinAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { settings, environment, childProcessSpawner, model, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        spawn: {
          command: devinCommand(settings),
          args: ["acp", ...(isExplicitDevinModel(model) ? ["--model", model] : [])],
          cwd: input.cwd,
          env: environment,
        },
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

/**
 * The advertised `model` value for a model slug: the value itself, a name
 * that matches, or the first variant of that family (`swe-1-6` → `swe-1-6-fast`).
 */
export function matchDevinModelValue(
  option: EffectAcpSchema.SessionConfigOption | undefined,
  slug: string,
): string | undefined {
  if (!option || option.type !== "select") return undefined;
  const entries = option.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
  const wanted = slug.toLowerCase();
  return (
    entries.find((entry) => entry.value.toLowerCase() === wanted)?.value ??
    entries.find((entry) => entry.name.toLowerCase() === wanted)?.value ??
    entries.find((entry) => entry.value.toLowerCase().startsWith(`${wanted}-`))?.value
  );
}

/** Devin's session mode for a turn: Plan, Bypass for full access, otherwise Code. */
export function devinModeId(input: {
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): string {
  if (input.interactionMode === "plan") return "plan";
  return input.runtimeMode === "full-access" ? "bypass" : "accept-edits";
}

/** Applies a turn's model and mode through Devin's config options. */
export const configureDevinSession = (input: {
  readonly runtime: AcpSessionRuntime.AcpSessionRuntime["Service"];
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly model: string | undefined;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    const configOptions = yield* input.runtime.getConfigOptions;
    if (isExplicitDevinModel(input.model)) {
      const value = matchDevinModelValue(
        findSessionConfigOption(configOptions, DEVIN_MODEL_CONFIG_ID),
        input.model,
      );
      if (value) {
        yield* input.runtime.setConfigOption(DEVIN_MODEL_CONFIG_ID, value);
      } else {
        // The launch `--model` already picked it fuzzily, or Devin lacks it.
        yield* Effect.logDebug("Devin does not list the requested model", { model: input.model });
      }
    }
    const modeOption = findSessionConfigOption(configOptions, DEVIN_MODE_CONFIG_ID);
    const modeId = devinModeId(input);
    if (modeOption && collectSessionConfigOptionValues(modeOption).includes(modeId)) {
      yield* input.runtime.setMode(modeId);
    }
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firstString(record: Record<string, unknown>, keys: ReadonlyArray<string>) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * Model families from `devin models list --format json`. Families own their
 * variants (effort and speed tiers), so variants are not listed separately.
 */
export function parseDevinModelList(stdout: string): ReadonlyArray<ServerProviderModel> {
  const start = stdout.search(/[[{]/);
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    return [];
  }
  const models: ServerProviderModel[] = [];
  const seen = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (!isRecord(value)) return;
    const slug = firstString(value, ["family_uid", "familyUid", "slug", "model_uid", "id"]);
    if (slug) {
      if (!seen.has(slug)) {
        seen.add(slug);
        models.push({
          slug,
          name: firstString(value, ["family_label", "name", "label", "displayName"]) ?? slug,
          isCustom: false,
          capabilities: EMPTY_CAPABILITIES,
        });
      }
      return;
    }
    Object.values(value).forEach(visit);
  };
  visit(parsed);
  return models;
}
