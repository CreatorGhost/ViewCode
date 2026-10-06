/**
 * Pure helpers for adding a Codex or Claude account from Settings: the
 * instance id a label becomes, and where a ViewCode-managed account keeps its
 * login. Shared by the web dialog (preview) and the server (which creates the
 * directories), so both agree on every path.
 */

/** Drivers whose accounts ViewCode can create and sign in from Settings. */
export const ACCOUNT_DRIVERS = ["codex", "claudeAgent"] as const;
export type AccountDriver = (typeof ACCOUNT_DRIVERS)[number];

export function isAccountDriver(driver: string): driver is AccountDriver {
  return (ACCOUNT_DRIVERS as readonly string[]).includes(driver);
}

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;
const MAX_INSTANCE_ID_LENGTH = 64;

/** "Work stuff" -> "work_stuff"; capped so `<driver>_<slug>` stays within 64 chars. */
export function slugifyAccountLabel(label: string): string {
  return label
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 48)
    .replace(/_+$/g, "");
}

/**
 * The instance id for a new account: `codex_work`, `claudeAgent_personal`.
 * Taken ids get a numeric suffix (`codex_work_2`) so a repeated label still
 * produces a usable id. Empty when the label has no usable characters.
 */
export function deriveAccountInstanceId(
  driver: AccountDriver,
  label: string,
  existingIds: ReadonlySet<string> = new Set(),
): string {
  const slug = slugifyAccountLabel(label);
  if (slug.length === 0) return "";
  const base = `${driver}_${slug}`.slice(0, MAX_INSTANCE_ID_LENGTH);
  if (!existingIds.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const tail = `_${suffix}`;
    const candidate = `${base.slice(0, MAX_INSTANCE_ID_LENGTH - tail.length)}${tail}`;
    if (!existingIds.has(candidate)) return candidate;
  }
  return "";
}

/** Same rules as `ProviderInstanceId`; returns a user-facing error or null. */
export function validateAccountInstanceId(
  id: string,
  existingIds: ReadonlySet<string>,
): string | null {
  if (id.length === 0) return "Type a label with at least one letter or digit.";
  if (id.length > MAX_INSTANCE_ID_LENGTH) return "Account ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Account ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existingIds.has(id)) return `An account named '${id}' already exists.`;
  return null;
}

/** Directory (under the server's state dir) holding every managed account home. */
export const MANAGED_ACCOUNT_HOMES_DIRNAME = "provider-accounts";

function joinPath(separator: "/" | "\\", ...parts: ReadonlyArray<string>): string {
  const [first = "", ...rest] = parts;
  const head = first.replace(/[\\/]+$/, "");
  const tail = rest.map((part) => part.replace(/^[\\/]+|[\\/]+$/g, "")).filter(Boolean);
  return [head, ...tail].join(separator);
}

/**
 * The config a managed account gets. Codex shares the default `CODEX_HOME`
 * (so accounts continue each other's threads, see providers-codex.md) and
 * keeps its own login in a shadow home. Claude has no shared-home mode, so the
 * account gets its own `CLAUDE_CONFIG_DIR`.
 *
 * `sharedCodexHome` is the CODEX_HOME the account should share; empty means
 * Codex's default (`~/.codex`), which is what the default Codex instance uses.
 */
export function managedAccountConfig(input: {
  readonly driver: AccountDriver;
  readonly instanceId: string;
  readonly stateDir: string;
  readonly sharedCodexHome?: string | undefined;
  readonly platform?: string | undefined;
}): { readonly homePath: string; readonly shadowHomePath?: string } {
  const separator = input.platform === "win32" ? "\\" : "/";
  const accountDir = joinPath(
    separator,
    input.stateDir,
    MANAGED_ACCOUNT_HOMES_DIRNAME,
    input.instanceId,
  );
  if (input.driver === "codex") {
    return { homePath: input.sharedCodexHome?.trim() ?? "", shadowHomePath: accountDir };
  }
  return { homePath: accountDir };
}

/**
 * Config for "Use existing directory". For Codex an existing directory is a
 * complete, separate CODEX_HOME (no shadow home): its own sessions, config and
 * login. For Claude it is the account's CLAUDE_CONFIG_DIR.
 */
export function existingDirectoryAccountConfig(
  _driver: AccountDriver,
  directory: string,
): { readonly homePath: string } {
  return { homePath: directory.trim() };
}

/** The login command for an account's CLI, quoted for a POSIX shell or PowerShell. */
export function accountLoginCommand(input: {
  readonly driver: AccountDriver;
  readonly binaryPath: string;
  readonly platform: "windows" | "posix";
}): string {
  const fallback = input.driver === "codex" ? "codex" : "claude";
  const binary = input.binaryPath.trim() || fallback;
  const quoted = /^[A-Za-z0-9_./:\\-]+$/.test(binary)
    ? binary
    : input.platform === "windows"
      ? `& '${binary.replaceAll("'", "''")}'`
      : `'${binary.replaceAll("'", `'\\''`)}'`;
  return input.driver === "codex" ? `${quoted} login` : `${quoted} auth login`;
}
