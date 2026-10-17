import { viewcodeProductPolicy } from "@t3tools/shared/viewcodeProductPolicy";
import { SshLaunchError } from "@t3tools/ssh/errors";
import type { RemoteT3RunnerOptions } from "@t3tools/ssh/tunnel";
import * as Effect from "effect/Effect";

/** Select only a runtime that belongs to ViewCode; upstream archives remain opt-in. */
export function resolveViewCodeSshCliRunner(
  input: {
    readonly explicitEntryPath: string | undefined;
    readonly appVersion: string;
    readonly nodeEngineRange: string;
  },
  nativeCliManagedRuntimeAllowed: boolean = viewcodeProductPolicy.nativeCliManagedRuntime,
): Effect.Effect<RemoteT3RunnerOptions, SshLaunchError> {
  const entryPath = input.explicitEntryPath?.trim();
  if (entryPath) {
    return Effect.succeed({ nodeScriptPath: entryPath, nodeEngineRange: input.nodeEngineRange });
  }
  // The inherited archive resolver points at upstream releases. Do not install
  // another product on the host just because its version matches this desktop.
  if (!nativeCliManagedRuntimeAllowed) {
    return Effect.fail(
      new SshLaunchError({
        message:
          "Automatic SSH runtime installation is unavailable in ViewCode. Install and start ViewCode on the remote host, then pair with its reachable address or use your own SSH port forward. An explicit remote server entry can be configured with T3CODE_DEV_REMOTE_T3_SERVER_ENTRY_PATH.",
        stdout: "",
      }),
    );
  }
  return Effect.succeed({ archiveVersion: input.appVersion });
}
