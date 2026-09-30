// @effect-diagnostics nodeBuiltinImport:off - Deploy tooling writes files the server reads and runs wrangler.
/**
 * ViewCode Quick connect setup: the file edits `scripts/viewcode-relay.ts`
 * makes, plus the wrangler-output helpers it shares with the in-app setup
 * (`@t3tools/shared/viewcodeRelaySetup`, re-exported here). The script itself
 * only sequences wrangler and these helpers.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { RELAY_HOST_SECRET_NAME } from "@t3tools/shared/viewcodeRelayProtocol";
import {
  parseLenientJson,
  parseRelayState,
  RELAY_STATE_FILE,
  type RelayState,
} from "@t3tools/shared/viewcodeRelaySetup";

export {
  DEFAULT_WORKER_NAME,
  describeFetchError,
  detectMissingWorkersDevSubdomain,
  generateHostSecret,
  isValidWorkerName,
  parseLenientJson,
  parseWorkerUrl,
  RELAY_STATE_FILE,
  type RelayState,
  wranglerNeedsLogin,
} from "@t3tools/shared/viewcodeRelaySetup";

export function secretFilePath(stateDir: string): string {
  return NodePath.join(stateDir, "secrets", `${RELAY_HOST_SECRET_NAME}.bin`);
}

type SettingsObject = Record<string, unknown>;

export function readSettingsFile(file: string): SettingsObject {
  if (!NodeFS.existsSync(file)) return {};
  const parsed = parseLenientJson(NodeFS.readFileSync(file, "utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Cannot read ${file} (not a JSON object); fix or remove it first.`);
  }
  return parsed as SettingsObject;
}

export function withRelaySettings(settings: SettingsObject, url: string): SettingsObject {
  return { ...settings, viewcodeRelay: { enabled: true, url } };
}

export function withoutRelaySettings(settings: SettingsObject): SettingsObject {
  const { viewcodeRelay: _removed, ...rest } = settings;
  return rest;
}

function writeFileAtomic(file: string, contents: string | Uint8Array, mode: number): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  NodeFS.writeFileSync(temporary, contents, { mode });
  NodeFS.renameSync(temporary, file);
}

export function writeSecretFile(stateDir: string, secret: string): void {
  const file = secretFilePath(stateDir);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(NodePath.dirname(file), 0o700);
  writeFileAtomic(file, secret, 0o600);
}

export function readSecretFile(stateDir: string): string | null {
  try {
    const value = NodeFS.readFileSync(secretFilePath(stateDir), "utf8").trim();
    return value === "" ? null : value;
  } catch {
    return null;
  }
}

export function removeSecretFile(stateDir: string): void {
  NodeFS.rmSync(secretFilePath(stateDir), { force: true });
}

export function writeSettingsFile(file: string, settings: SettingsObject): void {
  writeFileAtomic(file, `${JSON.stringify(settings, null, 2)}\n`, 0o600);
}

export function readRelayState(stateDir: string): RelayState | null {
  try {
    return parseRelayState(NodeFS.readFileSync(NodePath.join(stateDir, RELAY_STATE_FILE), "utf8"));
  } catch {
    return null;
  }
}

export function writeRelayState(stateDir: string, state: RelayState): void {
  writeFileAtomic(NodePath.join(stateDir, RELAY_STATE_FILE), `${JSON.stringify(state)}\n`, 0o600);
}

export function removeRelayState(stateDir: string): void {
  NodeFS.rmSync(NodePath.join(stateDir, RELAY_STATE_FILE), { force: true });
}

/** Reachable: the origin answered HTTP (any status), so the address works. */
export function formatReachableSetup(origin: string): string {
  return [
    `Quick connect is set up: ${origin}`,
    "Open ViewCode, Connect phone, Anywhere, and scan the QR code with the T3 Code app.",
    "Keep in mind: the relay is your own Worker, and it (and any network inspection) can see the traffic.",
  ].join("\n");
}

/**
 * Deployed and saved, but this computer could not reach the origin. Honest,
 * because a reset/TLS/timeout here does not mean the relay is broken: a newly
 * created workers.dev address can take a while to start answering, and the
 * problem may be this network. Does not claim "set up".
 */
export function formatUnreachable(origin: string, detail: string): string {
  return [
    `Deployed the relay, but this computer can't reach ${origin} right now (${detail}).`,
    "It may be your network, and it can also be that a new address takes time to work.",
    "The settings were saved. Try again later, or run `node scripts/viewcode-relay.ts check`.",
  ].join("\n");
}

/** No workers.dev subdomain: the Worker has no public address to reach. */
export function formatMissingSubdomain(settingsFile: string): string {
  return [
    "Deployed, but this Cloudflare account has no workers.dev subdomain, so the Worker has no address.",
    "Create one in the Cloudflare dashboard (Workers & Pages, then the workers.dev tab), then run deploy again.",
    `Nothing was written to ${settingsFile}.`,
  ].join("\n");
}
