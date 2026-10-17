// @effect-diagnostics nodeBuiltinImport:off
/**
 * ViewCode: a machine-wide provider policy that IT deploys, and that wins over
 * the user. A provider it blocks is off whatever settings.json says, so it is
 * never probed or launched; Settings shows it as blocked.
 *
 * ```json
 * { "providers": { "codex": { "allowed": false } } }
 * ```
 *
 * macOS reads the MDM managed preferences for the app's bundle id (the same
 * keys, as a plist), Linux and Windows a JSON file. It is read once at startup.
 *
 * @module provider/AdminProviderPolicy
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

import type { ServerSettings } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Context from "effect/Context";

const VIEWCODE_BUNDLE_ID = "dev.viewcode.app";

/** Where IT deploys the policy on each platform. */
export function adminProviderPolicyPath(platform: NodeJS.Platform): string {
  switch (platform) {
    case "darwin":
      return `/Library/Managed Preferences/${VIEWCODE_BUNDLE_ID}.plist`;
    case "win32":
      return "C:\\ProgramData\\ViewCode\\policy.json";
    default:
      return "/etc/viewcode/policy.json";
  }
}

export interface AdminProviderPolicy {
  /** Built-in provider drivers the policy blocks. */
  readonly blockedDrivers: ReadonlyArray<string>;
  /** Why a policy file that exists could not be applied, for the server log. */
  readonly problem: string | null;
}

const NO_POLICY: AdminProviderPolicy = { blockedDrivers: [], problem: null };

/** The drivers a decoded policy blocks: those with `allowed: false`. */
export function blockedDriversFromPolicy(policy: unknown): ReadonlyArray<string> {
  if (typeof policy !== "object" || policy === null) return [];
  const providers = (policy as { readonly providers?: unknown }).providers;
  if (typeof providers !== "object" || providers === null) return [];
  return Object.entries(providers).flatMap(([driver, rule]) =>
    typeof rule === "object" &&
    rule !== null &&
    (rule as { readonly allowed?: unknown }).allowed === false
      ? [driver]
      : [],
  );
}

/** Reads the policy at `filePath`; a missing file means no policy. */
export function readAdminProviderPolicyFile(filePath: string): AdminProviderPolicy {
  if (!NodeFS.existsSync(filePath)) return NO_POLICY;
  try {
    // Managed preferences are usually binary plists; Apple's plutil reads both kinds.
    const text = filePath.endsWith(".plist")
      ? NodeChildProcess.execFileSync(
          "/usr/bin/plutil",
          ["-convert", "json", "-o", "-", filePath],
          {
            encoding: "utf8",
          },
        )
      : NodeFS.readFileSync(filePath, "utf8");
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    return { blockedDrivers: blockedDriversFromPolicy(JSON.parse(text)), problem: null };
  } catch (cause) {
    return {
      blockedDrivers: [],
      problem: `Could not read the provider policy at ${filePath}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
}

/** This machine's policy, read on first use; tests provide their own. */
export const AdminProviderPolicyRef = Context.Reference<AdminProviderPolicy>(
  "server/provider/AdminProviderPolicy",
  {
    defaultValue: () =>
      readAdminProviderPolicyFile(adminProviderPolicyPath(HostProcessPlatform.defaultValue())),
  },
);

/**
 * Settings as the policy allows them: every blocked provider off, its legacy
 * slot and its instances alike. The file on disk keeps the user's own choice,
 * so lifting the policy restores it.
 */
export function applyAdminProviderPolicy(
  settings: ServerSettings,
  blockedDrivers: ReadonlyArray<string>,
): ServerSettings {
  if (blockedDrivers.length === 0) return settings;
  const blocked = new Set(blockedDrivers);
  return {
    ...settings,
    providers: Object.fromEntries(
      Object.entries(settings.providers).map(([driver, config]) => [
        driver,
        blocked.has(driver) ? { ...config, enabled: false } : config,
      ]),
    ) as ServerSettings["providers"],
    providerInstances: Object.fromEntries(
      Object.entries(settings.providerInstances).map(([instanceId, instance]) => [
        instanceId,
        blocked.has(instance.driver) ? { ...instance, enabled: false } : instance,
      ]),
    ) as ServerSettings["providerInstances"],
  };
}
