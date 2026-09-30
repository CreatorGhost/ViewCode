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

/** Wrangler's output when the account has no workers.dev subdomain and it could not ask. */
export function wranglerNeedsSubdomain(output: string): boolean {
  return /workers\.dev subdomain/iu.test(output);
}

export const NO_SUBDOMAIN_MESSAGE =
  "Your Cloudflare account has no workers.dev subdomain yet. Open https://dash.cloudflare.com -> Workers & Pages once to create it, then run this again.";

export const LOGIN_HINT =
  "Open the link wrangler shows and enter the code, in any browser (it does not need to be this computer's default browser).";

export type ProbeResult =
  | { readonly reachable: true; readonly status: number }
  | { readonly reachable: false; readonly cause: "reset" | "tls" | "timeout" | "dns" | "other" };

export const PROBE_TIMEOUT_MS = 10_000;

function errorChainText(error: unknown): string {
  const parts: string[] = [];
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if (typeof current !== "object") {
      parts.push(String(current));
      break;
    }
    const { code, message, name, cause } = current as Record<string, unknown>;
    for (const part of [code, name, message]) if (typeof part === "string") parts.push(part);
    current = cause;
  }
  return parts.join(" ");
}

export function classifyProbeError(
  error: unknown,
): Exclude<ProbeResult, { reachable: true }>["cause"] {
  const text = errorChainText(error);
  if (/ECONNRESET|UND_ERR_SOCKET|socket hang up|other side closed|ECONNABORTED/iu.test(text))
    return "reset";
  if (/TimeoutError|AbortError|ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|timed out/iu.test(text))
    return "timeout";
  if (/ENOTFOUND|EAI_AGAIN/iu.test(text)) return "dns";
  if (/CERT|self[- ]signed|SSL|TLS|certificate/iu.test(text)) return "tls";
  return "other";
}

/**
 * Whether this computer can reach `origin` with its own trust store. Any HTTP
 * answer counts (the Worker answers 503 while the host is not connected); what
 * matters is that the TLS handshake finished.
 */
export async function probeRelayOrigin(
  origin: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PROBE_TIMEOUT_MS,
): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(origin, {
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    void response.body?.cancel().catch(() => undefined);
    return { reachable: true, status: response.status };
  } catch (error) {
    return { reachable: false, cause: classifyProbeError(error) };
  }
}

const PROBE_CAUSE_TEXT = {
  reset: "the connection was reset",
  tls: "a TLS error",
  timeout: "it timed out",
  dns: "the name did not resolve",
  other: "the request failed",
} as const;

export function unreachableMessage(origin: string, cause: keyof typeof PROBE_CAUSE_TEXT): string {
  return `Deployed, but this computer can't reach ${origin} — your network blocked it (${PROBE_CAUSE_TEXT[cause]}). Quick connect can't work from this network unless it's allowed; on a work network, ask IT. Same Wi-Fi still works.`;
}
