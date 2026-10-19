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

import {
  defaultInstanceIdForDriver,
  isProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import { isAdminBlockedProvider } from "./viewcode/providerPolicyDrivers.ts";
const decodePolicy = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

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
    return { blockedDrivers: blockedDriversFromPolicy(decodePolicy(text)), problem: null };
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
      readAdminProviderPolicyFile(adminProviderPolicyPath(HostProcess.Platform.defaultValue())),
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
  const providerInstances: Record<ProviderInstanceId, ProviderInstanceConfig> = {
    ...settings.providerInstances,
  };
  for (const driver of blockedDrivers) {
    if (!isProviderDriverKind(driver)) continue;
    const instanceId = defaultInstanceIdForDriver(driver);
    providerInstances[instanceId] ??= { driver, enabled: false };
  }
  const blockedInstances = new Set<string>();
  for (const [instanceId, instance] of Object.entries(providerInstances)) {
    if (!isAdminBlockedProvider(instance, blockedDrivers)) continue;
    blockedInstances.add(instanceId);
    providerInstances[instanceId as ProviderInstanceId] = { ...instance, enabled: false };
  }
  return {
    ...settings,
    providerInstances,
    projectSettingsOverrides: Object.fromEntries(
      Object.entries(settings.projectSettingsOverrides).map(([projectId, overrides]) => [
        projectId,
        {
          ...overrides,
          ...(overrides.providerInstances
            ? {
                providerInstances: Object.fromEntries(
                  Object.entries(overrides.providerInstances).map(([instanceId, override]) => [
                    instanceId,
                    blockedInstances.has(instanceId) ? { ...override, enabled: false } : override,
                  ]),
                ),
              }
            : {}),
        },
      ]),
    ),
  };
}
