/**
 * Recognises a provider shell command that does nothing but run the
 * `viewcode-computer` CLI, so adapters can answer the provider's own
 * permission prompt for it without asking the user a second time.
 *
 * This is not a security gate for computer use. The CLI is a thin HTTP
 * client: every call it makes still goes through `ComputerUseService`, which
 * enforces the mode, the running turn, the denylist and ViewCode's own
 * approvals. What this check must guarantee is narrower: that approving the
 * shell command runs that CLI and nothing else, so the lexer below accepts
 * only plain words and quotes and rejects anything a shell would expand,
 * redirect, chain or substitute.
 */
import type { ThreadId } from "@t3tools/contracts";

import { readMcpProviderSession } from "../mcp/McpProviderSession.ts";
import { COMPUTER_CLI_NAME } from "./ComputerUseShim.ts";

/** Unquoted characters with shell meaning (operators, expansion, globbing, comments, history). */
const UNQUOTED_SPECIAL = new Set(";&|<>()$`\\*?[]{}~#!^");
/** Characters that keep their meaning inside double quotes. */
const DOUBLE_QUOTED_SPECIAL = new Set("$`\\!");
/** Shells whose `-c` / `-lc` script is plain shell syntax. */
const WRAPPING_SHELLS = new Set(["bash", "sh", "zsh"]);
const WRAPPING_SHELL_DIRS = ["", "/bin/", "/usr/bin/"];

/** Control characters (tab excepted), NUL, newlines and Unicode line breaks. */
const hasControlCharacter = (value: string) =>
  // oxlint-disable-next-line no-control-regex -- matching control characters is the point
  /[\u0000-\u0008\u000a-\u001f\u007f\u0085\u2028\u2029]/.test(value);

/**
 * Splits a script into words when it is only words, single-quoted strings
 * and double-quoted strings without expansions. Undefined for anything else.
 */
function plainWords(script: string): ReadonlyArray<string> | undefined {
  if (hasControlCharacter(script)) return undefined;
  const words: Array<string> = [];
  let word: string | undefined;
  let index = 0;
  while (index < script.length) {
    const char = script[index]!;
    if (char === " " || char === "\t") {
      if (word !== undefined) words.push(word);
      word = undefined;
      index += 1;
      continue;
    }
    if (char === "'" || char === '"') {
      const end = script.indexOf(char, index + 1);
      if (end < 0) return undefined;
      const quoted = script.slice(index + 1, end);
      if (char === '"' && [...quoted].some((inner) => DOUBLE_QUOTED_SPECIAL.has(inner))) {
        return undefined;
      }
      word = (word ?? "") + quoted;
      index = end + 1;
      continue;
    }
    if (UNQUOTED_SPECIAL.has(char)) return undefined;
    word = (word ?? "") + char;
    index += 1;
  }
  if (word !== undefined) words.push(word);
  return words;
}

/** A shell script that is exactly one plain `viewcode-computer` invocation. */
function isPlainComputerUseScript(script: string): boolean {
  // The command word must be the bare name, unquoted: no path, no assignment.
  const start = script.search(/[^ \t]/);
  if (start < 0 || !script.startsWith(COMPUTER_CLI_NAME, start)) return false;
  const next = script[start + COMPUTER_CLI_NAME.length];
  if (next !== undefined && next !== " " && next !== "\t") return false;
  return plainWords(script)?.[0] === COMPUTER_CLI_NAME;
}

const isWrappingShell = (program: string) =>
  WRAPPING_SHELL_DIRS.some(
    (dir) => program.startsWith(dir) && WRAPPING_SHELLS.has(program.slice(dir.length)),
  );

/** `bash -c <script>` / `bash -lc <script>` (also sh, zsh) as argv. */
function wrappedScript(argv: ReadonlyArray<string>): string | undefined {
  const [program, flag, script, ...rest] = argv;
  if (rest.length > 0 || program === undefined || script === undefined) return undefined;
  if (!isWrappingShell(program) || (flag !== "-c" && flag !== "-lc")) return undefined;
  return script;
}

/**
 * Whether a provider's shell command is strictly one plain `viewcode-computer`
 * invocation. A string is shell source; an array is argv, executed as is
 * unless it wraps a script in `bash|sh|zsh -c|-lc`. Rejects chaining,
 * redirection, substitution, globbing, env assignments, path or `sudo`/`env`
 * prefixes and anything else a shell would interpret.
 */
export function isPlainComputerUseCommand(command: string | ReadonlyArray<string>): boolean {
  if (typeof command === "string") {
    if (isPlainComputerUseScript(command)) return true;
    // Shell-joined argv of a wrapping shell, as some providers report it.
    const words = plainWords(command);
    const script = words ? wrappedScript(words) : undefined;
    return script !== undefined && isPlainComputerUseScript(script);
  }
  if (command.length === 0) return false;
  if (command[0] === COMPUTER_CLI_NAME) {
    return command.every((arg) => !hasControlCharacter(arg));
  }
  const script = wrappedScript(command);
  return script !== undefined && isPlainComputerUseScript(script);
}

/**
 * Whether an adapter may answer a provider's permission request for this
 * shell command itself. Only sessions spawned with computer use (the setting
 * was not "off", and the CLI is on the session's PATH) qualify. The setting is
 * re-read by `ComputerUseService` on every CLI call, so turning it off later
 * makes the approved command a refused no-op.
 */
export function autoApprovesComputerUseCommand(threadId: ThreadId, command: unknown): boolean {
  if (readMcpProviderSession(threadId)?.computerUseMode === undefined) return false;
  if (typeof command === "string") return isPlainComputerUseCommand(command);
  return (
    Array.isArray(command) &&
    command.every((part): part is string => typeof part === "string") &&
    isPlainComputerUseCommand(command)
  );
}
