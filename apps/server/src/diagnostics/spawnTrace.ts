// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalDate:off
/**
 * ViewCode: built-in spawn trace (managed-mode diagnostics).
 *
 * Appends one line per child process to `<stateDir>/logs/spawn-trace.log`
 * with a synchronous write, so the last line survives the server being
 * killed: time, pid, method, executable, its first argument only (prompts
 * and payloads are never logged), the provider when the executable is a
 * known provider CLI, and later its exit code or signal. The file is
 * truncated when the server starts and stops growing at about 1 MB.
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
const ARG_PREVIEW_LENGTH = 80;

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
  const [file, second] = args;
  if (method === "exec" || method === "execSync") {
    // A shell string: log only its first word.
    const words = String(file ?? "")
      .trim()
      .split(/\s+/);
    const exe = words[0] ?? "";
    return describe(exe, words.length > 1 ? "…" : undefined);
  }
  const first = Array.isArray(second) && second.length > 0 ? String(second[0]) : undefined;
  return describe(String(file ?? ""), first);
}

function describe(executable: string, firstArg: string | undefined): string {
  const provider = providerOf(executable);
  const arg =
    firstArg === undefined
      ? ""
      : ` ${JSON.stringify(firstArg.length > ARG_PREVIEW_LENGTH ? `${firstArg.slice(0, ARG_PREVIEW_LENGTH)}…` : firstArg)}`;
  return `${JSON.stringify(executable)}${arg}${provider ? ` provider=${provider}` : ""}`;
}

/**
 * Start tracing into `logDir/spawn-trace.log` (truncated now). Returns a
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
  let capped = false;
  try {
    NodeFS.mkdirSync(logDir, { recursive: true });
    NodeFS.writeFileSync(logPath, "");
  } catch {
    return () => {};
  }

  const write = (text: string) => {
    if (capped) return;
    try {
      let line = `${new Date().toISOString()} pid=${process.pid} ${text}\n`;
      if (written + Buffer.byteLength(line) > maxBytes) {
        capped = true;
        line = `${new Date().toISOString()} trace stopped at ${maxBytes} bytes\n`;
      }
      NodeFS.appendFileSync(logPath, line);
      written += Buffer.byteLength(line);
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
