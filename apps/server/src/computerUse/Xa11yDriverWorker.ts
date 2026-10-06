// @effect-diagnostics nodeBuiltinImport:off - the driver worker is a plain Node child process outside the Effect runtime.
/**
 * The IPC loop of the computer-use driver process. The server forks it with
 * the app's own executable and `ELECTRON_RUN_AS_NODE=1`, so on macOS it runs
 * as the app and shares its Accessibility and Screen Recording grants
 * (Electron's Helper executable has neither). See `Xa11yComputerDriver.ts`.
 *
 * xa11y loads on the first request, so a missing native module answers
 * `status` with "unavailable" instead of killing the process.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

import {
  makeDriverCore,
  type DriverRequest,
  type DriverResult,
  type Xa11yApi,
} from "./Xa11yDriverCore.ts";

type Xa11yModule = typeof import("@crowecawcaw/xa11y");

const SUPPORTED_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "win32", "linux"]);
// oxlint-disable-next-line t3code/no-global-process-runtime -- The driver worker has no Effect runtime.
const PLATFORM = process.platform;

/** macOS: one `ps` call; Linux: `/proc/<pid>/exe`; elsewhere nothing. */
const executablePaths = async (
  pids: ReadonlyArray<number>,
): Promise<ReadonlyMap<number, string>> => {
  const paths = new Map<number, string>();
  if (pids.length === 0) return paths;
  if (PLATFORM === "darwin") {
    const output = await new Promise<string>((resolve) => {
      NodeChildProcess.execFile(
        "/bin/ps",
        ["-o", "pid=,comm=", "-p", pids.join(",")],
        { timeout: 2_000 },
        (_error, stdout) => resolve(stdout ?? ""),
      );
    });
    for (const line of output.split("\n")) {
      const match = /^\s*(\d+)\s+(.+?)\s*$/.exec(line);
      if (match?.[1] && match[2]) paths.set(Number(match[1]), match[2]);
    }
  } else if (PLATFORM === "linux") {
    await Promise.all(
      pids.map(async (pid) => {
        const path = await NodeFSP.readlink(`/proc/${pid}/exe`).catch(() => undefined);
        if (path) paths.set(pid, path);
      }),
    );
  }
  return paths;
};

export const makeXa11yApi = (xa11y: Xa11yModule): Xa11yApi => ({
  listApps: () => xa11y.App.list(),
  appWindows: async (pid) => (await xa11y.App.byPid(pid, { timeout: 0 })).children(),
  foregroundPid: async () => (await xa11y.App.foreground({ timeout: 0 })).pid,
  inputSim: () => xa11y.inputSim(),
  screenshot: (element) => xa11y.screenshot({ element }),
  executablePaths,
  writeFile: async (path, bytes) => {
    await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
    await NodeFSP.writeFile(path, bytes);
  },
});

type Envelope = { readonly id: number; readonly request: DriverRequest };

const unavailable =
  (reason: string): ((request: DriverRequest) => DriverResult) =>
  (request) =>
    request.op === "status"
      ? { ok: true, result: { available: false, accessibility: "unknown", reason } }
      : { ok: false, error: { kind: "unavailable", message: reason, dispatched: "no" } };

const loadHandler = (): ((request: DriverRequest) => Promise<DriverResult> | DriverResult) => {
  if (!SUPPORTED_PLATFORMS.has(PLATFORM)) {
    return unavailable("Computer use is not supported on this platform.");
  }
  let xa11y: Xa11yModule;
  try {
    xa11y = NodeModule.createRequire(import.meta.url)("@crowecawcaw/xa11y") as Xa11yModule;
  } catch {
    return unavailable("The accessibility driver is not installed for this platform.");
  }
  // App lookups would otherwise poll for 5 s on a miss.
  xa11y.setDefaultTimeout(0);
  return makeDriverCore(makeXa11yApi(xa11y), PLATFORM).handle;
};

/** Answers one request at a time over the fork IPC channel until the parent disconnects. */
export const runComputerUseDriverWorker = (): Promise<void> =>
  new Promise((resolve) => {
    const send = process.send?.bind(process);
    if (!send) {
      process.stderr.write("computer-use-driver must be started with an IPC channel.\n");
      process.exitCode = 2;
      resolve();
      return;
    }
    let handler: ReturnType<typeof loadHandler> | undefined;
    let queue = Promise.resolve();
    process.on("message", (message: Envelope) => {
      queue = queue.then(async () => {
        handler ??= loadHandler();
        let reply: DriverResult;
        try {
          reply = await handler(message.request);
        } catch {
          reply = {
            ok: false,
            error: {
              kind: "failed",
              message: "The driver failed unexpectedly.",
              dispatched: "unknown",
            },
          };
        }
        send({ id: message.id, ...reply });
      });
    });
    process.once("disconnect", () => {
      resolve();
      process.exit(0);
    });
  });
