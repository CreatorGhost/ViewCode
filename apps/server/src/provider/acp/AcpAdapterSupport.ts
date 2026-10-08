import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ThreadId,
} from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  autoApprovesComputerUseCommand,
  isComputerUseScreenshotRead,
} from "../../computerUse/computerUseCommand.ts";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
} from "../Errors.ts";
const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterProcessError({
      provider,
      threadId,
      detail: error.message,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/** Raw-input fields providers use for the file a read tool opens. */
const READ_PATH_FIELDS = ["path", "filePath", "file_path", "target_file", "absolute_path"];

/**
 * True when a read request opens only this session's own computer-use
 * screenshots: every location and every path field present must be one.
 */
function readsOnlyComputerUseScreenshots(
  threadId: ThreadId,
  toolCall: EffectAcpSchema.RequestPermissionRequest["toolCall"],
): boolean {
  const input = Predicate.isObject(toolCall.rawInput)
    ? (toolCall.rawInput as Record<string, unknown>)
    : {};
  const paths = [
    ...(toolCall.locations ?? []).map((location) => location.path),
    ...READ_PATH_FIELDS.flatMap((field) => (input[field] === undefined ? [] : [input[field]])),
  ];
  return paths.length > 0 && paths.every((path) => isComputerUseScreenshotRead(threadId, path));
}

/**
 * The allow-once option to answer a permission request with when it only runs
 * the plain `viewcode-computer` CLI in a computer-use session, or only reads
 * that session's own screenshots; undefined otherwise. ViewCode's
 * computer-use gate decides each CLI call, so asking here too only doubled
 * every prompt, and a screenshot the CLI returned has to be opened to act on
 * it. Reads the raw input the agent will execute, never the display title.
 * Every listed command field present must pass, so two fields cannot
 * disagree about what runs.
 */
export function acpComputerUseAllowOnceOption(
  threadId: ThreadId,
  request: EffectAcpSchema.RequestPermissionRequest,
  options: {
    readonly commandFields?: ReadonlyArray<string>;
    /** Antigravity omits `kind` on shell calls. */
    readonly allowMissingKind?: boolean;
  } = {},
): string | undefined {
  const { kind, rawInput } = request.toolCall;
  if (kind === "read") {
    return readsOnlyComputerUseScreenshots(threadId, request.toolCall)
      ? request.options.find((option) => option.kind === "allow_once" && option.optionId.trim())
          ?.optionId
      : undefined;
  }
  if (kind !== "execute" && !(options.allowMissingKind && kind == null)) return undefined;
  if (!Predicate.isObject(rawInput)) return undefined;
  const input = rawInput as Record<string, unknown>;
  const commands = (options.commandFields ?? ["command"]).flatMap((field) =>
    input[field] === undefined ? [] : [input[field]],
  );
  if (
    commands.length === 0 ||
    !commands.every((command) => autoApprovesComputerUseCommand(threadId, command))
  ) {
    return undefined;
  }
  return request.options.find((option) => option.kind === "allow_once" && option.optionId.trim())
    ?.optionId;
}
