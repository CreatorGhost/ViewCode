// @effect-diagnostics nodeBuiltinImport:off - Host secret generation for the server and the CLI script.
/**
 * ViewCode Quick connect setup: the pure parts shared by the in-app setup
 * (`apps/server/src/relay/ViewCodeRelaySetup.ts`) and the CLI
 * (`scripts/viewcode-relay.ts`). Everything here reads wrangler's output or
 * produces values; nothing runs wrangler or touches files.
 */
import * as NodeCrypto from "node:crypto";

export const DEFAULT_WORKER_NAME = "viewcode-relay";
/** Where the Worker's name and address are remembered so remove can find it. */
export const RELAY_STATE_FILE = "viewcode-relay.json";
/** The wrangler major every deploy, secret and delete runs through `npx --yes`. */
export const WRANGLER_PACKAGE = "wrangler@4";

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

export interface RelayState {
  readonly name: string;
  readonly url: string;
  /** The Cloudflare account the Worker went to, when the setup knew it. */
  readonly accountId?: string;
}

/** Reads `viewcode-relay.json`; anything unexpected is "no relay remembered". */
export function parseRelayState(text: string): RelayState | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object") return null;
    const { name, url, accountId } = parsed as {
      name?: unknown;
      url?: unknown;
      accountId?: unknown;
    };
    if (typeof name !== "string" || typeof url !== "string") return null;
    return typeof accountId === "string" && accountId !== ""
      ? { name, url, accountId }
      : { name, url };
  } catch {
    return null;
  }
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
 * It offers to register one interactively; run non-interactively it declines
 * and either fails or deploys a Worker nobody can reach. Either way its output
 * mentions the workers.dev subdomain and no `*.workers.dev` address is printed.
 */
export function detectMissingWorkersDevSubdomain(output: string): boolean {
  return /workers\.dev subdomain/iu.test(output);
}

/** `wrangler delete` of a Worker that is already gone: nothing left to delete. */
export function detectWorkerAlreadyDeleted(output: string): boolean {
  return /\[code: 10007\]|script_not_found|does not exist|could not be found/iu.test(output);
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[A-Za-z]`, "gu");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, "");
}

/**
 * Removes every secret from text before it is logged or shown. The host
 * secret only ever reaches wrangler on stdin, but its output is still passed
 * through this so no future wrangler message can echo it to the UI.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | null>): string {
  let redacted = text;
  for (const secret of secrets) {
    if (secret !== null && secret.length >= 8) redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

export interface DeviceLoginPrompt {
  /** The page to open, e.g. https://dash.cloudflare.com/oauth2/device. */
  readonly url: string | null;
  /** The code to enter there. */
  readonly code: string | null;
}

/**
 * Reads the link and code from `wrangler login --device` output:
 *
 *   To authorize Wrangler, please visit:
 *
 *     https://dash.cloudflare.com/oauth2/device
 *
 *   and enter the code:
 *
 *     ABCD-EFGH
 *
 * Only https links on cloudflare.com count, matching wrangler's own check.
 * Either field is null until it has been printed (or if the wording changed).
 */
export function parseDeviceLoginPrompt(output: string): DeviceLoginPrompt {
  const text = stripAnsi(output);
  const visitIndex = text.search(/please visit:?/iu);
  const afterVisit = visitIndex === -1 ? text : text.slice(visitIndex);
  const urlMatch = /https:\/\/[a-z0-9.-]*cloudflare\.com\/[^\s"'<>]*/iu.exec(afterVisit);
  const codeMatch = /enter the code:?\s*\n?\s*([A-Za-z0-9]{3,}(?:-[A-Za-z0-9]{3,})*)\b/iu.exec(
    text,
  );
  return { url: urlMatch?.[0] ?? null, code: codeMatch?.[1] ?? null };
}

/** The link that pre-fills the code, built the way wrangler builds it. */
export function deviceLoginOpenUrl(prompt: DeviceLoginPrompt): string | null {
  if (prompt.url === null) return null;
  if (prompt.code === null) return prompt.url;
  try {
    const url = new URL(prompt.url);
    url.searchParams.set("user_code", prompt.code);
    return url.toString();
  } catch {
    return prompt.url;
  }
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

/**
 * Why a fresh relay address did not answer as expected:
 * - `network-refused`: this network reset the connection or broke TLS. A new
 *   workers.dev hostname is often reset by a corporate firewall for a while.
 * - `credential-rejected`: the relay answered 401/403 to this computer's secret.
 * - `transient`: DNS, timeout or a 5xx; the address may simply not be live yet.
 */
export type RelayProbeProblem = "network-refused" | "credential-rejected" | "transient";

export type RelayProbeOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "problem"; readonly problem: RelayProbeProblem; readonly detail: string };

const NETWORK_REFUSED =
  /ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|other side closed|EPROTO|ERR_SSL|SSL routines|TLS|CERT|certificate|self[- ]signed|UND_ERR_SOCKET/iu;

/** Classifies a probe that got no HTTP answer (the error's description). */
export function classifyProbeError(detail: string): RelayProbeOutcome {
  return {
    kind: "problem",
    problem: NETWORK_REFUSED.test(detail) ? "network-refused" : "transient",
    detail,
  };
}

/**
 * Classifies the relay's HTTP answer to `GET /__viewcode/host` with the host
 * secret as a bearer token. The Worker answers 426 (upgrade required) exactly
 * when the secret matches, so that is the only proof the setup works end to end.
 */
export function classifyProbeStatus(status: number): RelayProbeOutcome {
  if (status === 426) return { kind: "ok" };
  if (status === 401 || status === 403) {
    return {
      kind: "problem",
      problem: "credential-rejected",
      detail: `The relay answered ${status}.`,
    };
  }
  return { kind: "problem", problem: "transient", detail: `The relay answered ${status}.` };
}
