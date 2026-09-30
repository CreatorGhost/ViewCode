// @effect-diagnostics nodeBuiltinImport:off - Deploy tooling writes files the server reads and runs wrangler.
/**
 * ViewCode Quick connect setup: the parts of `scripts/viewcode-relay.ts` that
 * are worth testing without a Cloudflare account. The script itself only
 * sequences wrangler and these helpers.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { RELAY_HOST_SECRET_NAME } from "@t3tools/shared/viewcodeRelayProtocol";

export const DEFAULT_WORKER_NAME = "viewcode-relay";
/** Where the Worker's name and address are remembered so `remove` can find it. */
export const RELAY_STATE_FILE = "viewcode-relay.json";

/** Cloudflare Worker names: lowercase letters, digits and dashes. */
export function isValidWorkerName(name: string): boolean {
  return /^[a-z0-9](?:[a-z0-9-]{0,52}[a-z0-9])?$/u.test(name);
}

/** The `https://<name>.<account>.workers.dev` address wrangler prints after a deploy. */
export function parseWorkerUrl(output: string, name: string): string | null {
  const pattern = new RegExp(`https://${name}\\.[a-z0-9-]+\\.workers\\.dev`, "iu");
  return pattern.exec(output)?.[0]?.toLowerCase() ?? null;
}

/** 256 random bits, URL-safe. Never printed or logged by the caller. */
export function generateHostSecret(): string {
  return NodeCrypto.randomBytes(32).toString("base64url");
}

export function secretFilePath(stateDir: string): string {
  return NodePath.join(stateDir, "secrets", `${RELAY_HOST_SECRET_NAME}.bin`);
}

/**
 * Parsed as leniently as the server parses settings.json: comments and
 * trailing commas outside strings are dropped (same rule as build.sh --managed).
 */
export function parseLenientJson(text: string): unknown {
  const stripped = text
    .replace(/("(?:[^"\\]|\\.)*")|\/\/[^\n]*/gu, (match, str) => (str ? match : ""))
    .replace(/("(?:[^"\\]|\\.)*")|\/\*[\s\S]*?\*\//gu, (match, str) => (str ? match : ""))
    .replace(/("(?:[^"\\]|\\.)*")|,(\s*[}\]])/gu, (match, str, close) =>
      str ? match : (close ?? ""),
    );
  return JSON.parse(stripped);
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

export interface RelayState {
  readonly name: string;
  readonly url: string;
}

export function readRelayState(stateDir: string): RelayState | null {
  try {
    const parsed = JSON.parse(
      NodeFS.readFileSync(NodePath.join(stateDir, RELAY_STATE_FILE), "utf8"),
    );
    return typeof parsed?.name === "string" && typeof parsed?.url === "string"
      ? { name: parsed.name, url: parsed.url }
      : null;
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

/**
 * Whether `wrangler whoami` output says nobody is signed in. Anything else,
 * including output we do not recognise, counts as signed in, so a changed
 * message cannot loop the login.
 */
export function wranglerNeedsLogin(whoamiOutput: string, exitCode: number): boolean {
  return exitCode !== 0 || /not authenticated|not logged in|you are not/iu.test(whoamiOutput);
}

/**
 * wrangler needs a workers.dev subdomain before a Worker has a public address.
 * It offers to register one interactively; run non-interactively it answers
 * "no" itself and deploys a Worker nobody can reach. When that happens the
 * deploy output mentions the workers.dev subdomain and no `*.workers.dev`
 * address is printed, so the caller has both signals.
 */
export function detectMissingWorkersDevSubdomain(output: string): boolean {
  return /workers\.dev subdomain/iu.test(output);
}

/**
 * Flattens a fetch/undici error and its causes into one short phrase, so an
 * unreachable probe can say why (reset, TLS, timeout) without a stack trace.
 */
export function describeFetchError(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth += 1) {
    if (typeof current === "object") {
      const { name, code, message, cause } = current as {
        name?: unknown;
        code?: unknown;
        message?: unknown;
        cause?: unknown;
      };
      if (typeof code === "string") parts.push(code);
      else if (typeof name === "string" && parts.length === 0) parts.push(name);
      if (typeof message === "string" && message !== "") parts.push(message);
      current = cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  const joined = parts.join(": ");
  return joined === "" ? "unknown error" : joined;
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
