/**
 * Cursor's own CLI over ACP: `cursor-agent [-e <endpoint>] [--force | --auto-review] acp`.
 *
 * The v1 Cursor runtime, rebuilt on the native ACP adapter. What the CLI does
 * (from ViewCode v1, which ran it daily on a managed Mac):
 *
 * - It keeps its own login (`cursor-agent login`). v1 sent `authenticate` with
 *   `cursor_login` right after `initialize`, and so does this runtime: an
 *   auth-required answer from a real agent arrives without its error code (see
 *   docs/internals/viewcode.md, Droid), so reacting to it is not reliable.
 * - With the `parameterizedModelPicker` client capability, the
 *   `cursor/list_available_models` extension lists base models with their
 *   per-model config options (reasoning, context, fast, thinking).
 * - Permission behaviour is fixed at launch: `--force` approves everything
 *   (Full access), `--auto-review` is Cursor's own auto mode, and without either
 *   every tool call asks through `session/request_permission`.
 * - Session modes are `agent`, `plan` and `ask` (read-only).
 * - `cursor/ask_question` and `cursor/create_plan` are extension requests.
 *
 * Cursor's tools (`rg`, `cursorsandbox`) are children of `cursor-agent`, never
 * of the ViewCode server.
 *
 * @module CursorAgentAcpSupport
 */
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import type { ModelCapabilities, RuntimeMode, ServerProviderModel } from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import type * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { cursorAgentCommand } from "./cursorRuntime.ts";

const CURSOR_AGENT_AUTH_METHOD_ID = "cursor_login";
export const CURSOR_AGENT_CLIENT_META = { parameterizedModelPicker: true } as const;
const CURSOR_AGENT_MODE = "agent";
const EMPTY_CAPABILITIES = createModelCapabilities({ optionDescriptors: [] });

type CursorAgentSettings = Pick<CursorSettings, "binaryPath" | "apiEndpoint">;

function cursorAgentPermissionArgs(runtimeMode: RuntimeMode | undefined): ReadonlyArray<string> {
  switch (runtimeMode) {
    case "auto":
      return ["--auto-review"];
    case "full-access":
      return ["--force"];
    default:
      return [];
  }
}

function cursorAgentAcpArgs(
  settings: CursorAgentSettings,
  runtimeMode: RuntimeMode | undefined,
): ReadonlyArray<string> {
  const endpoint = settings.apiEndpoint?.trim();
  return [...(endpoint ? ["-e", endpoint] : []), ...cursorAgentPermissionArgs(runtimeMode), "acp"];
}

export interface CursorAgentAcpRuntimeInput extends Omit<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  "authMethodId" | "spawn"
> {
  readonly settings: CursorAgentSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly childProcessSpawner: ChildProcessSpawner.ChildProcessSpawner["Service"];
  readonly runtimeMode?: RuntimeMode | undefined;
}

export const makeCursorAgentAcpRuntime = (
  input: CursorAgentAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const { settings, environment, childProcessSpawner, runtimeMode, ...runtimeOptions } = input;
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        clientCapabilities: {
          ...runtimeOptions.clientCapabilities,
          _meta: { ...runtimeOptions.clientCapabilities?._meta, ...CURSOR_AGENT_CLIENT_META },
        },
        spawn: {
          command: cursorAgentCommand(settings),
          args: cursorAgentAcpArgs(settings, runtimeMode),
          cwd: input.cwd,
          env: environment,
        },
        authMethodId: CURSOR_AGENT_AUTH_METHOD_ID,
        authenticateEagerly: true,
      }).pipe(
        Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner)),
      ),
    );
    return yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(Effect.provide(context));
  });

/** A parameterized pick such as `gpt-5.4[reasoning=high]` names its base model first. */
export function cursorAgentBaseModelId(model: string | null | undefined): string {
  const trimmed = model?.trim() || "default";
  const bracket = trimmed.indexOf("[");
  return bracket === -1 ? trimmed : trimmed.slice(0, bracket);
}

/**
 * Sets the base model, `default` (Cursor's Auto) included, so switching back to
 * Auto mid-session applies. Its options are ACP config ids the native adapter sets.
 */
export const applyCursorAgentModel = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "setModel">,
  model: string | null | undefined,
): Effect.Effect<string, EffectAcpErrors.AcpError> => {
  const base = cursorAgentBaseModelId(model);
  return runtime.setModel(base).pipe(Effect.as(base));
};

/** Outside plan mode a turn runs in `agent`: `ask` is Cursor's read-only mode. */
export const configureCursorAgentMode = (input: {
  readonly runtime: Pick<
    AcpSessionRuntime.AcpSessionRuntime["Service"],
    "getModeState" | "setMode"
  >;
  readonly runtimePolicy: Pick<ProviderAdapter.ProviderAdapterV2RuntimePolicy, "interactionMode">;
}): Effect.Effect<void, EffectAcpErrors.AcpError> =>
  Effect.gen(function* () {
    if (input.runtimePolicy.interactionMode === "plan") return;
    const modes = yield* input.runtime.getModeState;
    if (
      modes === undefined ||
      modes.currentModeId === CURSOR_AGENT_MODE ||
      !modes.availableModes.some((mode) => mode.id === CURSOR_AGENT_MODE)
    ) {
      return;
    }
    yield* input.runtime.setMode(CURSOR_AGENT_MODE);
  });

const CursorAskQuestionRequest = Schema.Struct({
  toolCallId: Schema.String,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      prompt: Schema.String,
      options: Schema.Array(Schema.Struct({ id: Schema.String, label: Schema.String })),
      allowMultiple: Schema.optional(Schema.Boolean),
    }),
  ),
});

const CursorCreatePlanRequest = Schema.Struct({
  toolCallId: Schema.String,
  plan: Schema.String,
});

/** `cursor/ask_question` asks the user; `cursor/create_plan` becomes the proposed-plan card. */
export const registerCursorAgentExtensions: NonNullable<
  AcpAdapterV2Flavor["registerExtensions"]
> = ({ runtime, requestUserInput, captureProposedPlan }) =>
  Effect.gen(function* () {
    yield* runtime.handleExtRequest(
      "cursor/ask_question",
      CursorAskQuestionRequest,
      (params, requestContext) =>
        requestUserInput(
          {
            nativeItemId: `cursor-question:${params.toolCallId}`,
            nativeRequestId: params.toolCallId,
            questions: params.questions.map((question) => ({
              id: question.id,
              header: params.title?.trim() || "Question",
              question: question.prompt,
              multiSelect: question.allowMultiple === true,
              options:
                question.options.length > 0
                  ? question.options.map((option) => ({
                      label: option.label,
                      description: option.label,
                    }))
                  : [{ label: "OK", description: "Continue" }],
            })),
          },
          requestContext,
        ).pipe(
          Effect.tap(({ acknowledgeNativeResponse }) => acknowledgeNativeResponse),
          // v1's reply shape: answers keyed by question id.
          Effect.map(({ answers }) => ({ answers: answers ?? {} })),
        ),
    );
    yield* runtime.handleExtRequest("cursor/create_plan", CursorCreatePlanRequest, (params) =>
      captureProposedPlan({
        planMarkdown: params.plan || "# Plan\n\n(Cursor did not supply plan text.)",
      }).pipe(Effect.as({ accepted: true })),
    );
  });

const CursorListAvailableModelsResponse = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      value: Schema.String,
      name: Schema.String,
      configOptions: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
    }),
  ),
});
const decodeListAvailableModels = Schema.decodeUnknownEffect(CursorListAvailableModelsResponse);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** ACP v1 calls the id `id`, v2 `configId`; the extension reply is not normalized for us. */
function cursorAgentConfigOption(raw: unknown): EffectAcpSchema.SessionConfigOption | undefined {
  if (!isRecord(raw)) return undefined;
  const id = typeof raw.id === "string" ? raw.id : raw.configId;
  if (typeof id !== "string" || typeof raw.name !== "string") return undefined;
  const base = {
    id,
    name: raw.name,
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(typeof raw.category === "string" ? { category: raw.category } : {}),
  };
  if (raw.type === "boolean" && typeof raw.currentValue === "boolean") {
    return { ...base, type: "boolean", currentValue: raw.currentValue };
  }
  if (raw.type === "select" && typeof raw.currentValue === "string" && Array.isArray(raw.options)) {
    return {
      ...base,
      type: "select",
      currentValue: raw.currentValue,
      options: raw.options as EffectAcpSchema.SessionConfigSelectOptions,
    };
  }
  return undefined;
}

function cursorAgentModelCapabilities(
  configOptions: ReadonlyArray<unknown> | null | undefined,
): ModelCapabilities {
  const options = (configOptions ?? []).flatMap((raw) => {
    const option = cursorAgentConfigOption(raw);
    // The session mode follows ViewCode's plan toggle, not a per-model knob.
    return option === undefined || option.category === "mode" ? [] : [option];
  });
  return options.length === 0
    ? EMPTY_CAPABILITIES
    : createModelCapabilities({
        optionDescriptors: acpProviderOptionDescriptors({
          configOptions: options,
          modeState: undefined,
        }),
      });
}

export class CursorAgentModelDiscoveryError extends Schema.TaggedError<CursorAgentModelDiscoveryError>()(
  "CursorAgentModelDiscoveryError",
  { cause: Schema.Defect() },
) {
  override get message(): string {
    return "Could not read the Cursor CLI model list.";
  }
}

/** The models `cursor/list_available_models` lists, on a runtime that has started a session. */
export const listCursorAgentModels = (
  runtime: Pick<AcpSessionRuntime.AcpSessionRuntime["Service"], "request">,
): Effect.Effect<ReadonlyArray<ServerProviderModel>, CursorAgentModelDiscoveryError> =>
  runtime.request("cursor/list_available_models", {}).pipe(
    Effect.flatMap(decodeListAvailableModels),
    Effect.mapError((cause) => new CursorAgentModelDiscoveryError({ cause })),
    Effect.map((response) => {
      const seen = new Set<string>();
      return response.models.flatMap((model): ReadonlyArray<ServerProviderModel> => {
        const slug = model.value.trim();
        const name = model.name.trim();
        if (!slug || !name || seen.has(slug)) return [];
        seen.add(slug);
        return [
          {
            slug,
            name,
            isCustom: false,
            capabilities: cursorAgentModelCapabilities(model.configOptions),
          },
        ];
      });
    }),
  );
