/**
 * Which repository a `gh` invocation is about, so a machine signed in to several GitHub accounts
 * on one host can run it as an account that can see that repository. Pure: reads routing context,
 * argv and stdin.
 */
export interface GitHubCommandTarget {
  readonly host: string;
  /**
   * The repository owner, lowercased. Null for a command that reads the checkout it runs in
   * (`gh pr list` with no `--repo`), whose owner only the checkout's remotes can tell.
   */
  readonly owner: string | null;
  /** Changes nothing on GitHub, so repeating it as another account is safe. */
  readonly read: boolean;
}

const READ_SUBCOMMANDS: Record<string, ReadonlyArray<string>> = {
  pr: ["list", "view", "diff", "checks", "status"],
  repo: ["view"],
  run: ["list", "view"],
};
/** Commands that, without `--repo`, act on the checkout they run in. */
const CHECKOUT_COMMANDS = new Set(["pr", "repo", "run", "issue", "release", "workflow"]);
const FIELD_FLAGS = new Set(["-f", "-F", "--field", "--raw-field"]);

function ownerOfRepository(value: string): string | null {
  if (/^https?:\/\//i.test(value)) {
    try {
      return new URL(value).pathname.split("/").find((segment) => segment.length > 0) ?? null;
    } catch {
      return null;
    }
  }
  const parts = value.split("/");
  if (parts.length === 2) return parts[0] || null;
  if (parts.length === 3) return parts[1] || null;
  return null;
}

/** Owners a GraphQL document or search names inline: `owner: "x"` and `repo:x/y`. */
function ownersInText(text: string): Array<string> {
  return [
    ...Array.from(text.matchAll(/\bowner:\s*\\?"([^"\\]+)\\?"/g), (match) => match[1]!),
    ...Array.from(text.matchAll(/\brepo:([^\s/"\\]+)\//g), (match) => match[1]!),
  ];
}

function parseStdin(stdin: string | undefined): {
  readonly query: string | null;
  readonly owners: Array<string>;
} {
  if (stdin === undefined) return { query: null, owners: [] };
  try {
    const body: unknown = JSON.parse(stdin);
    if (typeof body !== "object" || body === null) return { query: null, owners: [] };
    const { query, variables } = body as { query?: unknown; variables?: unknown };
    const owners: Array<string> = [];
    if (typeof query === "string") owners.push(...ownersInText(query));
    if (typeof variables === "object" && variables !== null) {
      for (const [name, value] of Object.entries(variables)) {
        if (typeof value !== "string") continue;
        if (name === "owner") owners.push(value);
        else owners.push(...ownersInText(value));
      }
    }
    return { query: typeof query === "string" ? query : null, owners };
  } catch {
    return { query: null, owners: [] };
  }
}

/**
 * The repository owner and host a `gh` command targets, or null when it targets no single
 * repository owner (`gh api user`, a search across several owners) and so has no account to pick.
 */
export function gitHubCommandTarget(input: {
  readonly args: ReadonlyArray<string>;
  readonly stdin?: string | undefined;
  /** Repository context for requests addressed only by opaque node IDs. */
  readonly repository?: string | undefined;
  /** The host gh would use when the command names none. */
  readonly defaultHost: string;
}): GitHubCommandTarget | null {
  const { args } = input;
  const [command, action] = args;
  if (command === undefined || command === "auth") return null;
  const owners: Array<string> = [];
  const hosts: Array<string> = [];
  let method: string | null = null;
  let hasFields = false;
  let query: string | null = null;
  const addRepository = (value: string | undefined) => {
    if (value === undefined) return;
    const owner = ownerOfRepository(value);
    if (owner !== null) owners.push(owner);
    const parts = value.split("/");
    if (/^https?:\/\//i.test(value)) {
      try {
        hosts.push(new URL(value).host);
      } catch {
        // Not a URL after all; the owner above is all it gives.
      }
    } else if (parts.length === 3) hosts.push(parts[0]!);
  };
  addRepository(input.repository);
  if (command === "repo" && action === "view" && args[2] !== undefined && !args[2].startsWith("-"))
    addRepository(args[2]);
  for (let index = 1; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--repo" || arg === "-R") addRepository(args[++index]);
    else if (arg.startsWith("--repo=")) addRepository(arg.slice(7));
    else if (arg.startsWith("-R") && arg.length > 2) addRepository(arg.slice(2));
    else if (arg === "--hostname") hosts.push(args[++index] ?? "");
    else if (arg.startsWith("--hostname=")) hosts.push(arg.slice(11));
    else if (arg === "--method" || arg === "-X") method = args[++index]?.toUpperCase() ?? null;
    else if (arg === "--input") hasFields = true;
    else if (FIELD_FLAGS.has(arg)) {
      hasFields = true;
      const field = args[++index] ?? "";
      const separator = field.indexOf("=");
      const name = field.slice(0, separator);
      const value = field.slice(separator + 1);
      if (separator < 0) continue;
      if (name === "owner") owners.push(value);
      else if (name === "query") {
        query = value;
        owners.push(...ownersInText(value));
      } else owners.push(...ownersInText(value));
    } else if (/^https?:\/\//i.test(arg)) addRepository(arg);
    else {
      const path = /^\/?repos\/([^/?]+)\//.exec(arg);
      if (path) owners.push(path[1]!);
    }
  }
  const body = parseStdin(input.stdin);
  // Explicit context wins over repository mentions in user-authored mutation bodies.
  if (input.repository === undefined) owners.push(...body.owners);
  query ??= body.query;

  const distinctOwners = new Set(owners.map((owner) => owner.toLowerCase()));
  const distinctHosts = new Set(hosts.map((host) => host.toLowerCase()).filter(Boolean));
  if (distinctOwners.size > 1 || distinctHosts.size > 1) return null;
  const [owner = null] = distinctOwners;
  if (owner === null && (command === "api" || !CHECKOUT_COMMANDS.has(command))) return null;

  const read =
    command === "api"
      ? args.includes("graphql")
        ? query !== null && !/^\s*mutation\b/.test(query)
        : method === null
          ? !hasFields
          : method === "GET"
      : (READ_SUBCOMMANDS[command]?.includes(action ?? "") ?? false);
  const [host = input.defaultHost.toLowerCase()] = distinctHosts;
  return { host, owner, read };
}

/** The variables that make one `gh` invocation act as `token`, without touching gh's config. */
export function gitHubTokenEnv(host: string, token: string): NodeJS.ProcessEnv {
  // gh reads GH_TOKEN for github.com and GHE.com tenants, GH_ENTERPRISE_TOKEN for everything else.
  // Setting only the matching pair keeps the token off any other host a command might reach.
  const enterprise = host !== "github.com" && !host.endsWith(".ghe.com");
  return enterprise
    ? { GH_ENTERPRISE_TOKEN: token, GITHUB_ENTERPRISE_TOKEN: token, GH_DEBUG: "" }
    : { GH_TOKEN: token, GITHUB_TOKEN: token, GH_DEBUG: "" };
}

/** Whether a command already carries a credential of its caller's choosing. */
export function carriesGitHubToken(env: NodeJS.ProcessEnv | undefined): boolean {
  return (
    env !== undefined &&
    [env.GH_TOKEN, env.GITHUB_TOKEN, env.GH_ENTERPRISE_TOKEN, env.GITHUB_ENTERPRISE_TOKEN].some(
      (value) => value !== undefined && value !== "",
    )
  );
}
