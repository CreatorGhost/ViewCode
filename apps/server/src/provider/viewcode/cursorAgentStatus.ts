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
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
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
const INSTALL_DOCS_URL = "https://cursor.com/docs/cli/installation";
const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({ optionDescriptors: [] });

const CURSOR_AGENT_NOT_SIGNED_IN_MESSAGE =
  "The Cursor CLI is not signed in. Sign in here, or run `cursor-agent login` in a terminal.";

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
      return snapshot(settings, checkedAt, {
        installed: !missing,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: missing
          ? `The Cursor CLI (\`${cursorAgentCommand(settings)}\`) was not found. Install it (${INSTALL_DOCS_URL}), set its binary path, or choose the Cursor SDK runtime in Settings → Providers → Cursor.`
          : "Failed to run the Cursor CLI health check.",
      });
    }
    if (Option.isNone(aboutResult.success)) {
      return snapshot(settings, checkedAt, {
        installed: true,
        version: null,
        status: "error",
        auth: { status: "unknown" },
        message: "The Cursor CLI timed out while running `cursor-agent about`.",
      });
    }

    const about = parseCursorAgentAbout(aboutResult.success.value);
    if (about.auth.status === "unauthenticated") {
      return snapshot(settings, checkedAt, { installed: true, ...about });
    }
    const discovery = yield* discoverModels(about).pipe(
      Effect.timeoutOption(MODEL_DISCOVERY_TIMEOUT_MS),
      Effect.exit,
    );
    const discovered =
      Exit.isSuccess(discovery) && Option.isSome(discovery.value) ? discovery.value.value : [];
    if (Exit.isFailure(discovery)) {
      yield* Effect.logWarning("Cursor CLI model discovery failed", {
        errorTag: causeErrorTag(discovery.cause),
      });
    }
    const discoveryWarning =
      discovered.length > 0
        ? undefined
        : "Could not read the Cursor CLI model list. Update it with `cursor-agent update` if this persists.";
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
