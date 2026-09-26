// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * ViewCode: built-in spawn trace (managed-mode diagnostics).
 *
 * Appends one line per child process to `<stateDir>/logs/spawn-trace.log`
 * with a synchronous write, so the last line survives the server being
 * killed: time, pid, method, executable, the first argument only when it is a
 * known subcommand word (anything else is `<args>`, so prompts, paths and
 * payloads are never logged), the provider when the executable is a known
 * provider CLI, and later its exit code or signal. The file rotates, at server
 * start and whenever it reaches about 1 MB, into `.1` and `.2`, so the last
 * runs before a crash survive a restart and the total stays bounded.
 *
 * Coverage: everything that starts a process through Node's
 * `child_process` in this server process, including Effect's spawner and the
 * Claude Agent SDK. Not covered: processes those children start themselves,
 * the desktop main process (it has its own startup shell), native addons and
 * worker threads that bypass `child_process`. Tracing never throws into the
 * caller.
 *
 * @module diagnostics/spawnTrace
 */
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

export const SPAWN_TRACE_FILE_NAME = "spawn-trace.log";
const DEFAULT_MAX_BYTES = 1024 * 1024;
/** Rotated copies kept beside the live file: `.1` (newer) and `.2`. */
const ROTATED_FILES = 2;

/**
 * First arguments safe to log: subcommand words and flags of the CLIs this
 * server runs. Anything else could be a prompt, a path or a payload.
 */
const SAFE_FIRST_ARGS = new Set([
  "--version",
  "-v",
  "--help",
  "version",
  "about",
  "acp",
  "agent",
  "app-server",
  "auth",
  "inspect",
  "login",
  "mcp",
  "models",
  "serve",
  "status",
]);

/** Executable basenames of provider CLIs, for the `provider=` column. */
const PROVIDER_EXECUTABLES: Record<string, string> = {
  codex: "codex",
  claude: "claudeAgent",
  "cursor-agent": "cursor",
  grok: "grok",
  opencode: "opencode",
  cmd: "commandCode",
  "command-code": "commandCode",
  "antigravity-acp": "antigravity",
  localharness_external: "antigravity",
};

type ChildProcessModule = typeof import("node:child_process");
type Patchable = Record<string, (...args: Array<unknown>) => unknown>;

const TRACED_METHODS = [
  "spawn",
  "spawnSync",
  "execFile",
  "execFileSync",
  "exec",
  "execSync",
  "fork",
] as const;

let uninstallCurrent: (() => void) | undefined;

function providerOf(executable: string): string | undefined {
  const base = NodePath.basename(executable).replace(/\.(exe|cmd|bat)$/i, "");
  return PROVIDER_EXECUTABLES[base];
}

function describeCall(method: string, args: ReadonlyArray<unknown>): string {
  const [file, second, third] = args;
  const argv = Array.isArray(second) ? second : [];
  const options = Array.isArray(second) ? third : second;
  const viaShell =
    method === "exec" ||
    method === "execSync" ||
    (typeof options === "object" && options !== null && Boolean(Reflect.get(options, "shell")));
  if (viaShell) {
    // A shell command line: only its first word (quoted or not) is the
    // executable; the rest may be a prompt.
    const line = String(file ?? "").trim();
    const executable = /^"([^"]*)"|^(\S*)/.exec(line);
    const rest = line.slice(executable?.[0].length ?? 0).trim();
    return describe(executable?.[1] ?? executable?.[2] ?? "", [
      ...(rest ? rest.split(/\s+/) : []),
      ...argv,
    ]);
  }
  return describe(String(file ?? ""), argv);
}

function describe(executable: string, args: ReadonlyArray<unknown>): string {
  const provider = providerOf(executable);
  const [first] = args;
  const shown =
    args.length === 0
      ? ""
      : typeof first === "string" && SAFE_FIRST_ARGS.has(first)
        ? ` ${first}${args.length > 1 ? " <args>" : ""}`
        : " <args>";
  return `${JSON.stringify(executable)}${shown}${provider ? ` provider=${provider}` : ""}`;
}

/** `spawn-trace.log` → `.1` → `.2`; the oldest copy is dropped. */
function rotate(logPath: string) {
  for (let index = ROTATED_FILES; index >= 1; index -= 1) {
    const from = index === 1 ? logPath : `${logPath}.${index - 1}`;
    if (NodeFS.existsSync(from)) NodeFS.renameSync(from, `${logPath}.${index}`);
  }
}

/**
 * Start tracing into `logDir/spawn-trace.log` (the previous run's file is
 * rotated to `.1`). Returns a
 * function that restores the original methods. Calling it again replaces the
 * previous installation.
 */
export function installSpawnTrace(
  logDir: string,
  options: { readonly maxBytes?: number } = {},
): () => void {
  uninstallCurrent?.();
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const logPath = NodePath.join(logDir, SPAWN_TRACE_FILE_NAME);
  let written = 0;
  try {
    NodeFS.mkdirSync(logDir, { recursive: true });
    if (NodeFS.existsSync(logPath) && NodeFS.statSync(logPath).size > 0) rotate(logPath);
    NodeFS.writeFileSync(logPath, "");
  } catch {
    return () => {};
  }

  const write = (text: string) => {
    try {
      const line = `${new Date().toISOString()} pid=${process.pid} ${text}\n`;
      const bytes = Buffer.byteLength(line);
      if (written > 0 && written + bytes > maxBytes) {
        rotate(logPath);
        written = 0;
      }
      NodeFS.appendFileSync(logPath, line);
      written += bytes;
    } catch {
      // Never let tracing break the traced program.
    }
  };

  const childProcess = NodeModule.createRequire(import.meta.url)(
    "node:child_process",
  ) as ChildProcessModule;
  const target = childProcess as unknown as Patchable;
  const originals = new Map<string, Patchable[string]>();

  for (const method of TRACED_METHODS) {
    const original = target[method];
    if (typeof original !== "function") continue;
    originals.set(method, original);
    target[method] = function traced(this: unknown, ...args: Array<unknown>) {
      const detail = safe(() => describeCall(method, args)) ?? "?";
      write(`${method} ${detail}`);
      if (method.endsWith("Sync")) {
        try {
          const result = original.apply(this, args);
          if (method === "spawnSync") {
            const status = result as { status?: number | null; signal?: string | null };
            write(
              `exit ${detail} code=${status.status ?? "null"} signal=${status.signal ?? "null"}`,
            );
          } else {
            write(`exit ${detail} code=0`);
          }
          return result;
        } catch (error) {
          const failure = error as {
            status?: number | null;
            signal?: string | null;
            code?: string;
          };
          write(
            `exit ${detail} code=${failure.status ?? failure.code ?? "error"} signal=${failure.signal ?? "null"}`,
          );
          throw error;
        }
      }
      const child = original.apply(this, args) as {
        pid?: number;
        once?: (event: string, listener: (...values: Array<unknown>) => void) => void;
      };
      safe(() =>
        child?.once?.("exit", (code, signal) =>
          write(
            `exit ${detail} child=${child.pid ?? "?"} code=${String(code)} signal=${String(signal)}`,
          ),
        ),
      );
      return child;
    };
  }
  safe(() => NodeModule.syncBuiltinESMExports());

  const uninstall = () => {
    for (const [method, original] of originals) target[method] = original;
    safe(() => NodeModule.syncBuiltinESMExports());
    if (uninstallCurrent === uninstall) uninstallCurrent = undefined;
  };
  uninstallCurrent = uninstall;
  return uninstall;
}

function safe<A>(run: () => A): A | undefined {
  try {
    return run();
  } catch {
    return undefined;
  }
}
