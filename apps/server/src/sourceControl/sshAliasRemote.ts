/**
 * SSH config aliases in git remotes. `git@github.com-work:Org/app.git`, with `Host github.com-work`
 * / `HostName github.com` in `~/.ssh/config`, is the usual way to use a second key for a work
 * account. git follows the alias; nothing else does, so every place that reads a forge host from
 * a remote resolves the alias first and keeps the remote itself as written.
 *
 * @module sshAliasRemote
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

// Hosts that are never an SSH alias, so their remotes need no `ssh -G` lookup.
const WELL_KNOWN_REMOTE_HOSTS = new Set([
  "github.com",
  "ssh.github.com",
  "gitlab.com",
  "altssh.gitlab.com",
  "bitbucket.org",
  "altssh.bitbucket.org",
  "codeberg.org",
  "ssh.dev.azure.com",
]);

const PLAIN_HOST = /^[a-z0-9][a-z0-9._-]*$/i;
const IP_LITERAL = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-f:]+:[0-9a-f:]*)$/i;

/**
 * The host of an SSH remote (`[user@]host:owner/repo` or `ssh://[user@]host[:port]/owner/repo`),
 * or null for any other remote. Only plain host names are returned, so the value is safe to hand
 * to `ssh` as an argument.
 */
export function sshRemoteHost(remoteUrl: string): string | null {
  const url = remoteUrl.trim();
  const host =
    /^ssh:\/\/(?:[^@/\s]+@)?([^:/\s]+)(?::\d+)?\//i.exec(url)?.[1] ??
    (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)
      ? undefined
      : /^(?:[^@:/\s]+@)?([^:/\\\s]{2,}):(?!\/\/)/.exec(url)?.[1]);
  return host && PLAIN_HOST.test(host) ? host : null;
}

/** The `hostname` line of `ssh -G <alias>` output: the real host an SSH alias points at. */
export function parseSshConfigHostname(output: string): string | null {
  const match = /^hostname\s+(\S+)\s*$/im.exec(output);
  return match?.[1] ?? null;
}

/** The remote URL with its SSH host swapped for `to`; everything else is kept. */
export function withSshRemoteHost(remoteUrl: string, from: string, to: string): string {
  const url = remoteUrl.trim();
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return /^ssh:\/\//i.test(url)
    ? url.replace(new RegExp(`^(ssh://(?:[^@/\\s]+@)?)${escaped}(?=[:/])`, "i"), `$1${to}`)
    : url.replace(new RegExp(`^((?:[^@:/\\s]+@)?)${escaped}(?=:)`, "i"), `$1${to}`);
}

/**
 * Whether `ssh -G`'s hostname replaces the remote's host. An alias (no dot, or one pointing at a
 * known forge) does; a real host the config merely routes somewhere (`gitlab.company.com` to an
 * IP or a bastion name) keeps its own name, which is the one its web pages carry.
 */
export function followsSshHostname(host: string, hostname: string): boolean {
  if (!PLAIN_HOST.test(hostname) || hostname.toLowerCase() === host.toLowerCase()) return false;
  if (WELL_KNOWN_REMOTE_HOSTS.has(hostname.toLowerCase())) return true;
  if (IP_LITERAL.test(hostname)) return false;
  // `github.acme.com-work` -> `github.acme.com`: the alias names its host and adds a suffix.
  const lowerHost = host.toLowerCase();
  const lowerName = hostname.toLowerCase();
  if (lowerHost.length > lowerName.length && lowerHost.startsWith(lowerName)) {
    return /^[-_]/.test(lowerHost.slice(lowerName.length));
  }
  return !host.includes(".");
}

/**
 * Whether `host`, the host a repository was keyed on, is still the SSH alias its remote was
 * written with: one `resolveSshAliasRemote` would have replaced had `ssh -G` named a forge host.
 * No real host is undotted, and no top-level domain carries a `-` or `_` (`github.com-work`).
 */
export function isUnresolvedSshAlias(remoteUrl: string, host: string): boolean {
  const sshHost = sshRemoteHost(remoteUrl)?.toLowerCase();
  if (sshHost === undefined || sshHost !== host.toLowerCase()) return false;
  if (WELL_KNOWN_REMOTE_HOSTS.has(sshHost) || IP_LITERAL.test(sshHost)) return false;
  const topLabel = sshHost.split(".").at(-1) ?? "";
  return !sshHost.includes(".") || (/[-_]/.test(topLabel) && !topLabel.startsWith("xn--"));
}

/** Reads `ssh -G <host>` output, or null when ssh could not answer. */
export type SshConfigReader = (host: string) => Effect.Effect<string | null>;

// One answer per alias for a few minutes: detection runs often and the config rarely changes.
const ALIAS_TTL_MS = 5 * 60_000;
const aliases = new Map<string, { readonly at: number; readonly hostname: string | null }>();

/** The remote with an SSH alias host replaced by its real host; anything else unchanged. */
export const resolveSshAliasRemote = Effect.fn("resolveSshAliasRemote")(function* (
  remoteUrl: string,
  readSshConfig: SshConfigReader,
) {
  const host = sshRemoteHost(remoteUrl);
  if (host === null || WELL_KNOWN_REMOTE_HOSTS.has(host.toLowerCase())) return remoteUrl;
  const now = yield* Clock.currentTimeMillis;
  const key = host.toLowerCase();
  let cached = aliases.get(key);
  if (cached === undefined || now - cached.at > ALIAS_TTL_MS) {
    const output = yield* readSshConfig(host);
    // A failed or timed-out read is not an answer: it is not kept, so the next read asks again.
    if (output === null) return remoteUrl;
    cached = { at: now, hostname: parseSshConfigHostname(output) };
    aliases.delete(key);
    if (aliases.size >= 128) aliases.delete(aliases.keys().next().value!);
    aliases.set(key, cached);
  }
  return cached.hostname !== null && followsSshHostname(host, cached.hostname)
    ? withSshRemoteHost(remoteUrl, host, cached.hostname)
    : remoteUrl;
});
