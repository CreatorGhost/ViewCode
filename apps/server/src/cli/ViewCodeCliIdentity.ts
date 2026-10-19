export interface CliIdentity {
  readonly packageName: "viewcode-app" | "t3";
  readonly command: "viewcode" | "t3";
}

const VIEWCODE_CLI: CliIdentity = { packageName: "viewcode-app", command: "viewcode" };
const UPSTREAM_CLI: CliIdentity = { packageName: "t3", command: "t3" };

/** Explicit upstream package paths remain compatible; this fork owns source and desktop launches. */
export function cliIdentityForEntry(entryPath: string): CliIdentity {
  const path = entryPath.replaceAll("\\", "/");
  return /(?:^|\/)node_modules\/t3\//.test(path) ||
    /\/\.bun\/install\/cache\/t3(?:@[^/]+)?\//.test(path)
    ? UPSTREAM_CLI
    : VIEWCODE_CLI;
}

/** Global ownership still requires a matching package manifest and actual bin symlink. */
export function globalCliInstallLayout(entryPath: string) {
  const match =
    /^(.*)\/lib\/node_modules\/(viewcode-app|t3)\/(?:dist\/bin\.mjs|bin\/(?:t3|viewcode)\.mjs)$/.exec(
      entryPath,
    );
  if (match === null) return null;
  return { prefix: match[1] || "/", identity: match[2] === "t3" ? UPSTREAM_CLI : VIEWCODE_CLI };
}

/** Package ownership evidence is narrower than the default command suggested by this fork. */
export function isViewCodePackageEntry(entryPath: string): boolean {
  const path = entryPath.replaceAll("\\", "/");
  return (
    /(?:^|\/)node_modules\/viewcode-app\//.test(path) ||
    /\/\.bun\/install\/cache\/viewcode-app(?:@[^/]+)?\//.test(path)
  );
}
