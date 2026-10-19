import { ProviderDriverKind } from "@t3tools/contracts";
import {
  withAgentDeviceEnvironment,
  type McpProviderSessionConfig,
} from "@t3tools/provider-core/server/mcpSession";
import type * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import { ProviderAdapterProtocolError } from "@t3tools/provider-core/server/ProviderAdapter";

const scopedEnvironmentKeys = [
  "VIEWCODE_BROWSER_ENDPOINT",
  "VIEWCODE_BROWSER_AUTH",
  "VIEWCODE_REVIEW_ENDPOINT",
  "VIEWCODE_REVIEW_AUTH",
  "VIEWCODE_COMPUTER_ENDPOINT",
  "VIEWCODE_COMPUTER_AUTH",
  "VIEWCODE_COMPUTER_CLI",
  "VIEWCODE_COMPUTER_SCREENSHOTS_DIR",
] as const;

export function viewcodeCodexAppServerArgs(args: ReadonlyArray<string>): ReadonlyArray<string> {
  // ViewCode unsubscribes only after checking this thread's active/background
  // work. Native Codex otherwise retains it for 30 minutes and ignores changed
  // per-thread config until it closes. Keep other subscribed threads resident.
  return [...args, "--config", "thread_unload_delay_secs=0"];
}

export function withoutCodexThreadEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([key]) => !scopedEnvironmentKeys.some((name) => name === key),
    ),
  );
}

export function codexThreadEnvironment(
  session: McpProviderSessionConfig | undefined,
): NodeJS.ProcessEnv {
  const environment = withAgentDeviceEnvironment({}, session);
  return environment.PATH === undefined
    ? environment
    : {
        ...environment,
        PATH_SEPARATOR:
          session?.agentDeviceEnvironment?.PATH_SEPARATOR ?? session?.cliPathSeparator ?? ":",
      };
}

export function codexThreadEnvironmentOverrides(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly processEnvironment: NodeJS.ProcessEnv;
  readonly shellConfig: Schema.Json | undefined;
}): Readonly<Record<string, Schema.Json>> {
  const policy = input.shellConfig;
  const set =
    policy !== null && typeof policy === "object" && !Array.isArray(policy) && "set" in policy
      ? policy.set
      : undefined;
  const configuredPath =
    set !== null && typeof set === "object" && !Array.isArray(set) && "PATH" in set
      ? set.PATH
      : undefined;
  const path =
    typeof configuredPath === "string"
      ? configuredPath
      : (input.processEnvironment.PATH ?? input.processEnvironment.Path);
  const shimPath = input.environment.PATH;
  const separator = input.environment.PATH_SEPARATOR ?? ":";
  const environment = {
    ...Object.fromEntries(scopedEnvironmentKeys.map((key) => [key, ""])),
    ...input.environment,
    ...(shimPath ? { PATH: path ? `${shimPath}${separator}${path}` : shimPath } : {}),
  };
  // Leaf overrides preserve inherit/exclude/include_only and unrelated managed
  // set entries. In particular, never replace the whole enterprise shell policy.
  return Object.fromEntries(
    Object.entries(environment)
      .filter(([key, value]) => key !== "PATH_SEPARATOR" && value !== undefined)
      .map(([key, value]) => [`shell_environment_policy.set.${key}`, value ?? ""]),
  );
}

export const makeCodexThreadEnvironmentTracker = Effect.sync(() => {
  const credentials = new Map<string, string | null>();
  const closing = new Map<string, Deferred.Deferred<void>>();
  return {
    remember: (nativeThreadId: string, credentialId: string | null) =>
      Effect.sync(() => {
        credentials.set(nativeThreadId, credentialId);
      }),
    closed: (nativeThreadId: string) =>
      Effect.suspend(() => {
        const receipt = closing.get(nativeThreadId);
        return receipt === undefined
          ? Effect.void
          : Deferred.succeed(receipt, undefined).pipe(Effect.asVoid);
      }),
    refreshIfChanged: <E>(input: {
      readonly nativeThreadId: string;
      readonly credentialId: string | null;
      readonly hasPendingWork: Effect.Effect<boolean>;
      readonly unsubscribe: Effect.Effect<"notLoaded" | "notSubscribed" | "unsubscribed", E>;
    }) =>
      Effect.gen(function* () {
        const previous = credentials.get(input.nativeThreadId);
        if (previous === undefined || previous === input.credentialId) return;
        if (yield* input.hasPendingWork)
          return yield* new ProviderAdapterProtocolError({
            driver: ProviderDriverKind.make("codex"),
            detail: "Finish or stop this thread's background work before changing its tools.",
          });
        const receipt = yield* Deferred.make<void>();
        closing.set(input.nativeThreadId, receipt);
        return yield* Effect.gen(function* () {
          const status = yield* input.unsubscribe;
          if (status === "notLoaded") return;
          if (status === "notSubscribed")
            return yield* new ProviderAdapterProtocolError({
              driver: ProviderDriverKind.make("codex"),
              detail: "Close this thread in its other Codex connection before changing its tools.",
            });
          // Native config is ignored while loaded. Wait for the thread-local
          // unload receipt; other threads in the shared app-server keep running.
          yield* Deferred.await(receipt).pipe(
            Effect.timeoutOrElse({
              duration: "90 seconds",
              orElse: () =>
                Effect.fail(
                  new ProviderAdapterProtocolError({
                    driver: ProviderDriverKind.make("codex"),
                    detail:
                      "Codex has not unloaded this thread yet. Retry after its background runtime closes.",
                  }),
                ),
            }),
          );
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              closing.delete(input.nativeThreadId);
            }),
          ),
        );
      }),
  };
});
