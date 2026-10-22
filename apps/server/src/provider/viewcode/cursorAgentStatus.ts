/**
 * Cursor CLI health check: `cursor-agent about --format json` for the version
 * and login, then the model list from `cursor/list_available_models`. It runs
 * only for an enabled instance on the `cursor-agent` runtime.
 *
 * @module CursorAgentStatus
 */
import type { CursorSettings } from "@t3tools/provider-cursor/settings";
import type {
  ModelCapabilities,
  ServerProviderAuth,
  ServerProviderModel,
  ServerProviderState,
} from "@t3tools/contracts";
import { createModelCapabilities } from "@t3tools/shared/model";
import { causeErrorTag } from "@t3tools/shared/observability";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as ChildProcess from "effect/process/ChildProcess";
import type * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import {
  buildServerProvider,
  COMPACT_SLASH_COMMAND,
  isCommandMissingCause,
  providerModelsFromSettings,
  spawnAndCollect,
  type CommandResult,
  type ServerProviderDraft,
  type ServerProviderPresentation,
} from "@t3tools/provider-core/server/snapshotProbe";
import type { CursorAgentModelDiscoveryError } from "./cursorAgentAcpSupport.ts";
import { cursorAgentCommand } from "./cursorRuntime.ts";

const CURSOR_AGENT_PRESENTATION = {
  displayName: "Cursor",
  badgeLabel: "CLI",
  supportsConversationRollback: false,
  showInteractionModeToggle: true,
} as const satisfies ServerProviderPresentation;

const ABOUT_TIMEOUT_MS = 8_000;
const MODEL_DISCOVERY_TIMEOUT_MS = 15_000;
/** Right after a wake the network or a cold CLI can need a moment; one retry waits this long. */
export const MODEL_DISCOVERY_RETRY_DELAY = Duration.seconds(5);
const INSTALL_DOCS_URL = "https://cursor.com/docs/cli/installation";
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const CURSOR_AGENT_NOT_SIGNED_IN_MESSAGE =
  "The Cursor CLI is not signed in. Sign in here, or run `cursor-agent login` in a terminal.";
// A failed list says nothing about the CLI's version, so it never suggests an update.
const CURSOR_AGENT_MODELS_UNREACHABLE_MESSAGE = "Couldn't reach Cursor to list models; will retry.";
const CURSOR_AGENT_LOGIN_UNREADABLE_MESSAGE =
  "The Cursor CLI has a saved sign-in but could not confirm it just now. The Mac's login Keychain may be locked (for example after sleep) or the network may be down. ViewCode checks again when a message fails, when the Mac wakes or you return to the window, and on its next status refresh. If `cursor-agent status` in a terminal says you are signed out, run `cursor-agent login`.";

/**
 * Why the Cursor CLI could not use its sign-in. Only `signed-out` means the user
 * must log in; the others clear up on their own once the Keychain is unlocked or
 * the network is back, and a fresh `cursor-agent` process reads the login again.
 */
export type CursorAgentAuthProblem = "signed-out" | "credentials-unreadable" | "network";

const KEYCHAIN_FAILURE = /keychain|errsec|user interaction is not allowed|-25308|secitem/i;
const NETWORK_FAILURE =
  /enotfound|econnrefused|econnreset|etimedout|eai_again|enetunreach|enetdown|getaddrinfo|fetch failed|network|socket hang up|offline/i;
const SIGNED_OUT_FAILURE =
  /not (?:logged|signed) in|log ?in required|authenticat(?:ion|e) required|unauthenticated|unauthori[sz]ed|(?:cursor-)?agent login/i;

/** The readable text of a failure: messages, ACP error messages and stderr, outermost first. */
export function cursorAgentFailureText(cause: unknown): string {
  const parts: Array<string> = [];
  const seen = new Set<unknown>();
  let current = cause;
  for (let depth = 0; depth < 8 && current != null && !seen.has(current); depth++) {
    seen.add(current);
    if (typeof current === "string") {
      parts.push(current);
      break;
    }
    if (typeof current !== "object") break;
    const record = current as Record<string, unknown>;
    for (const key of ["errorMessage", "message", "stderr"] as const) {
      const value = record[key];
      if (typeof value === "string" && value.trim() && !parts.includes(value)) parts.push(value);
    }
    current = record.cause;
  }
  return parts.join("\n");
}

export function classifyCursorAgentAuthProblem(text: string): CursorAgentAuthProblem | undefined {
  if (KEYCHAIN_FAILURE.test(text)) return "credentials-unreadable";
  if (NETWORK_FAILURE.test(text)) return "network";
  if (SIGNED_OUT_FAILURE.test(text)) return "signed-out";
  return undefined;
}

export interface CursorAgentAbout {
  readonly version: string | null;
  readonly status: Exclude<ServerProviderState, "disabled">;
  readonly auth: ServerProviderAuth;
  readonly message?: string;
}

const CLI_AUTH_LABEL = "Cursor CLI login";

function isLoggedOut(email: string): boolean {
  const lower = email.toLowerCase();
  return (
    lower === "not logged in" ||
    lower.includes("login required") ||
    lower.includes("authentication required")
  );
}

function subscriptionLabel(tier: string | undefined): string | undefined {
  const words = tier
    ?.split(/[\s_-]+/g)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
  return words && words.length > 0 ? `Cursor ${words.join(" ")} (CLI)` : undefined;
}

function fromEmail(
  version: string | null,
  email: string | undefined,
  tier: string | undefined,
  exitCode: number,
): CursorAgentAbout {
  if (email === undefined) {
    return exitCode === 0
      ? { version, status: "ready", auth: { status: "unknown", label: CLI_AUTH_LABEL } }
      : {
          version,
          status: "warning",
          auth: { status: "unknown" },
          message: "Could not verify the Cursor CLI sign-in.",
        };
  }
  if (isLoggedOut(email)) {
    return {
      version,
      status: "error",
      auth: { status: "unauthenticated" },
      message: CURSOR_AGENT_NOT_SIGNED_IN_MESSAGE,
    };
  }
  return {
    version,
    status: "ready",
    auth: {
      status: "authenticated",
      email,
      label: subscriptionLabel(tier) ?? CLI_AUTH_LABEL,
      ...(tier ? { type: tier } : {}),
    },
  };
}

/** `about --format json` (`cliVersion`, `userEmail`, `subscriptionTier`), or the older text form. */
export function parseCursorAgentAbout(result: CommandResult): CursorAgentAbout {
  const trimmed = result.stdout.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const record = parsed as Record<string, unknown>;
        const version = typeof record.cliVersion === "string" ? record.cliVersion.trim() : null;
        const tier =
          typeof record.subscriptionTier === "string"
            ? record.subscriptionTier.trim() || undefined
            : undefined;
        if ("userEmail" in record && record.userEmail == null) {
          return fromEmail(version, "not logged in", tier, result.code);
        }
        const email =
          typeof record.userEmail === "string" ? record.userEmail.trim() || undefined : undefined;
        return fromEmail(version, email, tier, result.code);
      }
    } catch {
      // Fall through to the text form.
    }
  }
  // eslint-disable-next-line no-control-regex -- strips ANSI colour codes from CLI output
  const plain = `${result.stdout}\n${result.stderr}`.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
  const field = (key: string) => new RegExp(`^${key}\\s{2,}(.+)$`, "mi").exec(plain)?.[1]?.trim();
  return fromEmail(field("CLI Version") ?? null, field("User Email"), undefined, result.code);
}

export const runCursorAgentCommand = (
  settings: Pick<CursorSettings, "binaryPath">,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
) =>
  Effect.gen(function* () {
    const command = cursorAgentCommand(settings);
    const spawnCommand = yield* resolveSpawnCommand(command, args, { env: environment });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

const readAbout = (settings: CursorSettings, environment: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const json = yield* runCursorAgentCommand(settings, ["about", "--format", "json"], environment);
    const output = `${json.stdout}\n${json.stderr}`.toLowerCase();
    // CLIs from before `--format` reject the flag.
    return output.includes("'--format'") || output.includes("unexpected argument '--format'")
      ? yield* runCursorAgentCommand(settings, ["about"], environment)
      : json;
  });

function snapshot(
  settings: CursorSettings,
  checkedAt: string,
  probe: Parameters<typeof buildServerProvider>[0]["probe"],
  discovered: ReadonlyArray<ServerProviderModel> = [],
): ServerProviderDraft {
  return buildServerProvider({
    presentation: CURSOR_AGENT_PRESENTATION,
    enabled: settings.enabled,
    checkedAt,
    models: providerModelsFromSettings(discovered, settings.customModels, EMPTY_CAPABILITIES),
    slashCommands: [COMPACT_SLASH_COMMAND],
    probe,
  });
}

export function buildInitialCursorAgentSnapshot(
  settings: CursorSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.map(DateTime.now, (now) =>
    snapshot(settings, DateTime.formatIso(now), {
      installed: settings.enabled,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: settings.enabled
        ? "Checking the Cursor CLI (cursor-agent)..."
        : "Cursor is disabled in ViewCode settings.",
    }),
  );
}

export const checkCursorAgentProviderStatus = Effect.fn("checkCursorAgentProviderStatus")(
  function* (
    settings: CursorSettings,
    environment: NodeJS.ProcessEnv,
    discoverModels: (
      about: CursorAgentAbout,
    ) => Effect.Effect<ReadonlyArray<ServerProviderModel>, CursorAgentModelDiscoveryError>,
    /** Whether the CLI's config still names a logged-in account (no secret is read). */
    hasSavedLogin: Effect.Effect<boolean> = Effect.succeed(false),
    /** The last list that loaded; a check that cannot reach Cursor keeps it. */
    lastKnownModels: Effect.Effect<ReadonlyArray<ServerProviderModel>> = Effect.succeed([]),
  ): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
    const checkedAt = DateTime.formatIso(yield* DateTime.now);
    if (!settings.enabled) {
      return snapshot(settings, checkedAt, {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "Cursor is disabled in ViewCode settings.",
      });
    }

    const aboutResult = yield* readAbout(settings, environment).pipe(
      Effect.timeoutOption(ABOUT_TIMEOUT_MS),
      Effect.result,
    );
    if (Result.isFailure(aboutResult)) {
      const missing = isCommandMissingCause(aboutResult.failure);
      return snapshot(
        settings,
        checkedAt,
        {
          installed: !missing,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: missing
            ? `The Cursor CLI (\`${cursorAgentCommand(settings)}\`) was not found. Install it (${INSTALL_DOCS_URL}), set its binary path, or choose the Cursor SDK runtime in Settings → Providers → Cursor.`
            : "Failed to run the Cursor CLI health check.",
        },
        missing ? [] : yield* lastKnownModels,
      );
    }
    if (Option.isNone(aboutResult.success)) {
      return snapshot(
        settings,
        checkedAt,
        {
          installed: true,
          version: null,
          status: "error",
          auth: { status: "unknown" },
          message: "The Cursor CLI timed out while running `cursor-agent about`.",
        },
        yield* lastKnownModels,
      );
    }

    const about = parseCursorAgentAbout(aboutResult.success.value);
    if (about.auth.status === "unauthenticated") {
      // "Not logged in" is also what the CLI says when it cannot read its token
      // (a locked Keychain after sleep) or reach Cursor. Reporting that as signed
      // out sends the user to a login that cannot help, so only a CLI with no
      // saved login, or one that says nothing about why, counts as signed out.
      const output = `${aboutResult.success.value.stdout}\n${aboutResult.success.value.stderr}`;
      const problem = classifyCursorAgentAuthProblem(output);
      const savedLogin = yield* hasSavedLogin;
      const transient = problem === "credentials-unreadable" || problem === "network" || savedLogin;
      yield* Effect.logWarning("Cursor CLI reports no sign-in", {
        reading: transient ? (problem ?? "saved-login-unconfirmed") : "signed-out",
        savedLogin,
        exitCode: aboutResult.success.value.code,
      });
      if (!transient) return snapshot(settings, checkedAt, { installed: true, ...about });
      return snapshot(
        settings,
        checkedAt,
        {
          installed: true,
          version: about.version,
          status: "warning",
          auth: { status: "unknown", label: CLI_AUTH_LABEL },
          message: CURSOR_AGENT_LOGIN_UNREADABLE_MESSAGE,
        },
        yield* lastKnownModels,
      );
    }
    const discovery = yield* discoverModels(about).pipe(
      Effect.timeout(MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.filterOrFail((models) => models.length > 0),
      Effect.retry({ times: 1, schedule: Schedule.exponential(MODEL_DISCOVERY_RETRY_DELAY) }),
      Effect.exit,
    );
    if (Exit.isFailure(discovery)) {
      yield* Effect.logWarning("Cursor CLI model discovery failed", {
        errorTag: causeErrorTag(discovery.cause),
      });
    }
    const discovered = Exit.isSuccess(discovery) ? discovery.value : yield* lastKnownModels;
    const discoveryWarning = Exit.isSuccess(discovery)
      ? undefined
      : CURSOR_AGENT_MODELS_UNREACHABLE_MESSAGE;
    const message = [about.message, discoveryWarning].filter(Boolean).join(" ");
    return snapshot(
      settings,
      checkedAt,
      {
        installed: true,
        version: about.version,
        status: discoveryWarning && about.status === "ready" ? "warning" : about.status,
        auth: about.auth,
        ...(message ? { message } : {}),
      },
      discovered,
    );
  },
);
