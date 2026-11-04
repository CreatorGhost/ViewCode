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
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/compat";

import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as AcpSessionRuntime from "@t3tools/provider-acp/server/AcpSessionRuntime";
import type { AcpAdapterV2Flavor } from "@t3tools/provider-acp/server/adapter";
import { acpProviderOptionDescriptors } from "@t3tools/provider-acp/server/sessionConfig";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { cursorAgentCommand } from "./cursorRuntime.ts";
import {
  classifyCursorAgentAuthProblem,
  cursorAgentFailureText,
  type CursorAgentAuthProblem,
} from "./cursorAgentStatus.ts";

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
  /** Turns only: ends a prompt `cursor-agent` stopped answering (`watchPromptStalls`). */
  readonly promptStallTimeout?: Duration.Input | undefined;
  /** With `promptStallTimeout`: one element each time the host wakes or unlocks. */
  readonly hostWakes?: Stream.Stream<void> | undefined;
}

/**
 * Ten minutes of awake time. Model output streams, so a working agent is rarely
 * silent that long; the long silences (a build, `delegate_task` waiting on a child,
 * a question to the user) happen inside a reported tool call or a request to us,
 * and those pause the watch.
 */
export const CURSOR_AGENT_PROMPT_STALL_TIMEOUT = Duration.minutes(10);

/**
 * After a wake the user is looking at the spinner, and an agent that survived
 * the sleep writes again within seconds: a model stream resumes or its request
 * fails.
 */
export const CURSOR_AGENT_WAKE_STALL_TIMEOUT = Duration.seconds(90);

const CURSOR_AGENT_STALLED_MESSAGE = "Cursor stopped responding; send it again.";

export class CursorAgentStalledError extends Schema.TaggedError<CursorAgentStalledError>()(
  "CursorAgentStalledError",
  { idleSeconds: Schema.Number },
) {
  override get message(): string {
    return CURSOR_AGENT_STALLED_MESSAGE;
  }
}

const isCursorAgentStalledError = Schema.is(CursorAgentStalledError);
const isAcpInputStreamEndedError = Schema.is(EffectAcpErrors.AcpInputStreamEndedError);

type StallWatchedOptions = Pick<
  AcpSessionRuntime.AcpSessionRuntimeOptions,
  | "transformStdout"
  | "transformSessionUpdate"
  | "onIncomingRequest"
  | "onOutgoingResponse"
  | "onOutgoingResponseFailure"
>;

/**
 * After the Mac sleeps, a `cursor-agent` whose connection to Cursor died can
 * leave `session/prompt` unanswered forever while the process stays alive. A
 * prompt fails with `CursorAgentStalledError` once the agent has written nothing
 * to stdout for `timeout`, unless it is running a tool it reported or waiting on
 * a request we have not answered. The idle time is monotonic, which stops while
 * the machine sleeps, so the sleep itself never counts. When the host wakes
 * mid-prompt, the agent has `CURSOR_AGENT_WAKE_STALL_TIMEOUT` to write again
 * before the same rule ends the turn. On a stall the agent gets `session/cancel`
 * in case it wakes; the caller replaces the process before the next turn and
 * never resends the prompt.
 */
const watchPromptStalls = Effect.fnUntraced(function* (
  timeout: Duration.Input,
  hostWakes: Stream.Stream<void>,
  options: StallWatchedOptions,
) {
  const timeoutNanos = Duration.toNanosUnsafe(Duration.fromInputUnsafe(timeout));
  const wakeTimeoutNanos = Duration.toNanosUnsafe(CURSOR_AGENT_WAKE_STALL_TIMEOUT);
  const scope = yield* Effect.scope;
  let lastFrameAt = yield* Clock.monotonicTimeNanos;
  // A wake during the prompt with no frame since.
  let wokeAt: bigint | undefined;
  const unanswered = new Set<string>();
  const runningTools = new Set<string>();
  const touch = Clock.clockWith((clock) =>
    Effect.sync(() => {
      lastFrameAt = clock.monotonicTimeNanosUnsafe();
      wokeAt = undefined;
    }),
  );
  const answered = (requestId: string) =>
    Effect.sync(() => unanswered.delete(requestId)).pipe(Effect.andThen(touch));

  const runtimeOptions = {
    transformStdout: (stdout) =>
      (options.transformStdout?.(stdout) ?? stdout).pipe(Stream.tap(() => touch)),
    // Synchronous by contract, and it sees every `session/update` before the runtime does.
    transformSessionUpdate: (notification) => {
      const update = notification.update;
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        if (update.status === "completed" || update.status === "failed") {
          runningTools.delete(update.toolCallId);
        } else if (update.sessionUpdate === "tool_call" || update.status != null) {
          runningTools.add(update.toolCallId);
        }
      }
      return options.transformSessionUpdate?.(notification) ?? notification;
    },
    onIncomingRequest: (requestId, method, payload) =>
      Effect.sync(() => unanswered.add(requestId)).pipe(
        Effect.andThen(options.onIncomingRequest?.(requestId, method, payload) ?? Effect.void),
      ),
    onOutgoingResponse: (requestId) =>
      answered(requestId).pipe(
        Effect.andThen(options.onOutgoingResponse?.(requestId) ?? Effect.void),
      ),
    onOutgoingResponseFailure: (requestId, error) =>
      answered(requestId).pipe(
        Effect.andThen(options.onOutgoingResponseFailure?.(requestId, error) ?? Effect.void),
      ),
  } satisfies StallWatchedOptions;

  const stalled = Effect.gen(function* () {
    const woke = yield* Queue.sliding<void>(1);
    yield* hostWakes.pipe(
      Stream.runForEach(() =>
        Clock.monotonicTimeNanos.pipe(
          Effect.flatMap((now) => {
            wokeAt = now;
            return Queue.offer(woke, undefined);
          }),
        ),
      ),
      Effect.forkScoped,
    );
    while (true) {
      const now = yield* Clock.monotonicTimeNanos;
      const window = wokeAt === undefined ? timeoutNanos : wakeTimeoutNanos;
      const idleDeadline = lastFrameAt + timeoutNanos;
      const deadline =
        wokeAt === undefined || idleDeadline < wokeAt + wakeTimeoutNanos
          ? idleDeadline
          : wokeAt + wakeTimeoutNanos;
      const busy = unanswered.size > 0 || runningTools.size > 0;
      if (!busy && now >= deadline) {
        return new CursorAgentStalledError({
          idleSeconds: Number((now - lastFrameAt) / 1_000_000_000n),
        });
      }
      yield* Effect.raceFirst(
        Effect.sleep(Duration.nanos(busy ? window : deadline - now)),
        Queue.take(woke),
      );
    }
  }).pipe(Effect.scoped);

  const wrap = (
    runtime: AcpSessionRuntime.AcpSessionRuntime["Service"],
  ): AcpSessionRuntime.AcpSessionRuntime["Service"] => ({
    ...runtime,
    prompt: (payload, promptOptions) =>
      Effect.sync(() => runningTools.clear()).pipe(
        Effect.andThen(touch),
        Effect.andThen(
          Effect.raceFirst(
            runtime.prompt(payload, promptOptions),
            stalled.pipe(
              Effect.tap(() => runtime.cancel.pipe(Effect.ignore, Effect.forkIn(scope))),
              Effect.flatMap(
                (stall) =>
                  new EffectAcpErrors.AcpTransportError({
                    method: "session/prompt",
                    detail: "cursor-agent stopped responding to the prompt",
                    cause: stall,
                  }),
              ),
            ),
          ),
        ),
      ),
  });

  return { runtimeOptions, wrap };
});

export const makeCursorAgentAcpRuntime = (
  input: CursorAgentAcpRuntimeInput,
): Effect.Effect<
  AcpSessionRuntime.AcpSessionRuntime["Service"],
  EffectAcpErrors.AcpError,
  Crypto.Crypto | Scope.Scope
> =>
  Effect.gen(function* () {
    const {
      settings,
      environment,
      childProcessSpawner,
      runtimeMode,
      promptStallTimeout,
      hostWakes,
      ...runtimeOptions
    } = input;
    const stallWatch =
      promptStallTimeout === undefined
        ? undefined
        : yield* watchPromptStalls(promptStallTimeout, hostWakes ?? Stream.never, runtimeOptions);
    const context = yield* Layer.build(
      AcpSessionRuntime.layer({
        ...runtimeOptions,
        ...stallWatch?.runtimeOptions,
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
    const runtime = yield* Effect.service(AcpSessionRuntime.AcpSessionRuntime).pipe(
      Effect.provide(context),
    );
    return stallWatch === undefined ? runtime : stallWatch.wrap(runtime);
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

/**
 * A turn that failed because the CLI lost or could not read its sign-in, or lost
 * the network. The process is replaced before the next turn: a long-lived
 * `cursor-agent` can keep that state in memory after the Mac sleeps while a new
 * one (like the user's terminal) reads the saved login again.
 */
export function cursorAgentPromptAuthProblem(cause: unknown): CursorAgentAuthProblem | undefined {
  return classifyCursorAgentAuthProblem(cursorAgentFailureText(cause));
}

const NEXT_MESSAGE_RETRY =
  "ViewCode closed that Cursor CLI process, so your next message starts a fresh one that reads the sign-in again.";

function cursorAgentPromptFailureMessage(problem: CursorAgentAuthProblem, detail: string): string {
  const quoted = detail ? ` (Cursor CLI: "${detail}")` : "";
  switch (problem) {
    case "credentials-unreadable":
      return `The Cursor CLI could not read its saved sign-in${quoted}. On a Mac this usually means the login Keychain is locked, for example after sleep. Unlock the Mac and send the message again. ${NEXT_MESSAGE_RETRY}`;
    case "network":
      return `The Cursor CLI could not reach Cursor${quoted}, which often happens right after sleep or a network change. ${NEXT_MESSAGE_RETRY} Send it again once you are online.`;
    case "signed-out":
      return `The Cursor CLI session reported that it is not signed in${quoted}. ${NEXT_MESSAGE_RETRY} If it fails again, run \`cursor-agent status\` in a terminal, and \`cursor-agent login\` only if that says you are signed out.`;
  }
}

/**
 * A prompt the stall watch ended, or one whose connection to `cursor-agent` closed
 * under it. A process that exited keeps its own error, which carries its stderr.
 */
export function cursorAgentPromptStalled(cause: unknown): boolean {
  const seen = new Set<unknown>();
  let current = cause;
  for (let depth = 0; depth < 8 && typeof current === "object" && current !== null; depth++) {
    if (seen.has(current)) break;
    seen.add(current);
    if (isCursorAgentStalledError(current) || isAcpInputStreamEndedError(current)) return true;
    const record = current as Record<string, unknown>;
    if (record._tag === "AcpTransportError" && record.operation === "read-input-stream") {
      return true;
    }
    current = record.cause;
  }
  return false;
}

/** The turn failure the user sees; other failures keep the adapter's default. */
export function cursorAgentPromptFailure(cause: unknown) {
  if (cursorAgentPromptStalled(cause)) {
    return makeProviderFailure({
      cause,
      class: "transport_error",
      message: CURSOR_AGENT_STALLED_MESSAGE,
      retryable: true,
    });
  }
  const problem = cursorAgentPromptAuthProblem(cause);
  if (problem === undefined) return makeProviderFailure({ cause, class: "provider_error" });
  const detail = cursorAgentFailureText(cause).split("\n")[0]?.trim().slice(0, 300) ?? "";
  return makeProviderFailure({
    cause,
    class: problem === "network" ? "transport_error" : "provider_error",
    message: cursorAgentPromptFailureMessage(problem, detail),
    retryable: true,
  });
}
