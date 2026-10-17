import * as Effect from "effect/Effect";
import * as Cache from "effect/Cache";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

/** Read effective SSH configuration without connecting or changing authentication. */
export const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const aliases = yield* Cache.make({
    capacity: 128,
    timeToLive: "5 minutes",
    lookup: (key: string) => {
      const [cwd = ".", alias = ""] = key.split("\u0000");
      return host.process.run({
        operation: "GitHubSshAlias.resolve", command: "ssh", args: ["-G", alias], cwd,
        allowNonZeroExit: true, timeoutMs: 5_000, maxOutputBytes: 64 * 1024,
      }).pipe(
        Effect.map((output) => output.exitCode === 0
          ? /^hostname\s+([a-z0-9][a-z0-9._-]*)\s*$/im.exec(output.stdout)?.[1]?.toLowerCase() ?? alias
          : alias),
        Effect.orElseSucceed(() => alias),
      );
    },
  });
  return Effect.fn("GitHubSshAlias.remote")(function* (remote: string, cwd: string) {
    const match = /^(ssh:\/\/(?:[^@/\s]+@)?)([^:/\s]+)(?=[:/])/.exec(remote)
      ?? /^((?:[^@:/\s]+@)?)([a-z0-9][a-z0-9._-]+)(?=:)/i.exec(remote);
    if (match === null) return remote;
    const alias = match[2]!.toLowerCase();
    if (alias === "github.com" || alias === "ssh.github.com") return remote;
    const hostname = yield* Cache.get(aliases, `${cwd}\u0000${alias}`);
    // Real enterprise hosts may route SSH through a bastion. Only aliases may change API host.
    const suffixAlias = alias.startsWith(hostname) && /^[-_]/.test(alias.slice(hostname.length));
    if (hostname === alias || !(hostname === "github.com" || !alias.includes(".") || suffixAlias)) return remote;
    return `${match[1]}${hostname}${remote.slice(match[0].length)}`;
  });
});
